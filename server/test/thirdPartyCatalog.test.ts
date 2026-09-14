import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyThirdParty } from "../src/analysis/thirdPartyCatalog.js";

test("classifies known analytics providers", () => {
  assert.equal(classifyThirdParty("Google Analytics"), "analytics");
  assert.equal(classifyThirdParty("Mixpanel"), "analytics");
});

test("classifies known advertising providers", () => {
  assert.equal(classifyThirdParty("Google/Doubleclick Ads"), "advertising");
  assert.equal(classifyThirdParty("Criteo"), "advertising");
});

test("classifies known chat/support widgets", () => {
  assert.equal(classifyThirdParty("Intercom"), "chat");
  assert.equal(classifyThirdParty("Zendesk"), "chat");
});

test("classifies known social embeds, without misclassifying Facebook Pixel as social", () => {
  assert.equal(classifyThirdParty("Twitter"), "social");
  assert.equal(classifyThirdParty("Facebook Pixel"), "advertising");
});

test("classifies known font providers and general libraries/CDNs", () => {
  assert.equal(classifyThirdParty("Google Fonts"), "font");
  assert.equal(classifyThirdParty("jQuery CDN"), "library");
});

test("an unrecognized entity name is classified as 'other', never guessed", () => {
  assert.equal(classifyThirdParty("Totally Unknown Widget Co"), "other");
});

test("matching is case-insensitive", () => {
  assert.equal(classifyThirdParty("google analytics"), "analytics");
  assert.equal(classifyThirdParty("GOOGLE ANALYTICS"), "analytics");
});
