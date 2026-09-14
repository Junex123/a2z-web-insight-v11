import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { analyzeStructuredData, compareStructuredDataToPage, findDuplicateBlocks, findEntityConflicts, findIncompleteItems, parseJsonLd } from "../src/analysis/structuredData.js";

function page(html: string) {
  return cheerio.load(html);
}

test("parses a valid JSON-LD Organization block", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Acme Co","url":"https://acme.example"}
  </script></head><body></body></html>`;
  const { items, malformed } = parseJsonLd(page(html));
  assert.equal(malformed.length, 0);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].types, ["Organization"]);
  assert.equal(items[0].data.name, "Acme Co");
});

test("flattens @graph into multiple items", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Acme Co","url":"https://acme.example"},
      {"@type":"WebSite","name":"Acme Site","url":"https://acme.example"}
    ]}
  </script></head><body></body></html>`;
  const { items } = parseJsonLd(page(html));
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => i.types[0]),
    ["Organization", "WebSite"],
  );
});

test("records malformed JSON-LD as evidence rather than throwing", () => {
  const html = `<html><head><script type="application/ld+json">
    { this is not valid json ]]
  </script></head><body></body></html>`;
  const { items, malformed } = parseJsonLd(page(html));
  assert.equal(items.length, 0);
  assert.equal(malformed.length, 1);
  assert.ok(malformed[0].error.length > 0);
  assert.ok(malformed[0].snippet.includes("this is not valid json"));
});

test("detects duplicate structured-data blocks", () => {
  const block = '{"@type":"Organization","name":"Acme Co","url":"https://acme.example"}';
  const html = `<html><head>
    <script type="application/ld+json">${block}</script>
    <script type="application/ld+json">${block}</script>
  </head><body></body></html>`;
  const { items } = parseJsonLd(page(html));
  const duplicates = findDuplicateBlocks(items);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].indexes.length, 2);
});

test("flags a Product missing required properties", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"Product"}
  </script></head><body></body></html>`;
  const { items } = parseJsonLd(page(html));
  const incomplete = findIncompleteItems(items);
  assert.equal(incomplete.length, 1);
  assert.deepEqual(incomplete[0].missingProperties, ["name"]);
});

test("does not flag a complete Organization", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"Organization","name":"Acme Co","url":"https://acme.example"}
  </script></head><body></body></html>`;
  const { items } = parseJsonLd(page(html));
  const incomplete = findIncompleteItems(items);
  assert.equal(incomplete.length, 0);
});

test("detects a Product price that doesn't match visible page text", () => {
  const mismatches = compareStructuredDataToPage(
    [{ index: 0, types: ["Product"], data: { name: "Widget", offers: { price: "49999", priceCurrency: "INR" } } }],
    { title: "Widget", h1Texts: ["Widget"], visibleText: "Buy the Widget today for 54999 rupees.", pageUrl: "https://example.com/widget" },
  );
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].property, "offers.price");
});

test("does not flag a Product price that matches visible page text", () => {
  const mismatches = compareStructuredDataToPage(
    [{ index: 0, types: ["Product"], data: { name: "Widget", offers: { price: "49999", priceCurrency: "INR" } } }],
    { title: "Widget", h1Texts: ["Widget"], visibleText: "Buy the Widget today for $49999.", pageUrl: "https://example.com/widget" },
  );
  assert.equal(mismatches.length, 0);
});

test("detects an Organization name absent from any visible page content", () => {
  const mismatches = compareStructuredDataToPage(
    [{ index: 0, types: ["Organization"], data: { name: "Totally Different Co", url: "https://example.com" } }],
    { title: "Home | Example", h1Texts: ["Welcome"], visibleText: "This site sells widgets.", pageUrl: "https://example.com" },
  );
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].property, "name");
});

test("analyzeStructuredData composes parsing, duplicates, completeness, and comparison", () => {
  const html = `<html><head>
    <title>Widget</title>
    <script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"price":"100","priceCurrency":"USD"}}</script>
  </head><body><h1>Widget</h1><p>Only $200 today.</p></body></html>`;
  const $ = page(html);
  const result = analyzeStructuredData($, { title: "Widget", h1Texts: ["Widget"], visibleText: "Widget Only $200 today.", pageUrl: "https://example.com/widget" });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.typesFound, ["Product"]);
  assert.equal(result.contentMismatches.length, 1);
});

test("findEntityConflicts detects two Organization blocks disagreeing on name", () => {
  const items = [
    { index: 0, types: ["Organization"], data: { name: "Acme Inc", url: "https://acme.example" } },
    { index: 1, types: ["Organization"], data: { name: "Acme Corp", url: "https://acme.example" } },
  ];
  const conflicts = findEntityConflicts(items);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, "Organization");
  assert.equal(conflicts[0].property, "name");
});

test("findEntityConflicts does not flag agreeing entities", () => {
  const items = [
    { index: 0, types: ["Organization"], data: { name: "Acme Inc" } },
    { index: 1, types: ["Organization"], data: { name: "acme inc" } }, // same, differs only by case
  ];
  assert.deepEqual(findEntityConflicts(items), []);
});

test("findEntityConflicts requires at least two matching entities", () => {
  const items = [{ index: 0, types: ["Organization"], data: { name: "Acme Inc" } }];
  assert.deepEqual(findEntityConflicts(items), []);
});

test("findEntityConflicts does not check Product (different products legitimately have different names)", () => {
  const items = [
    { index: 0, types: ["Product"], data: { name: "Widget A" } },
    { index: 1, types: ["Product"], data: { name: "Widget B" } },
  ];
  assert.deepEqual(findEntityConflicts(items), []);
});
