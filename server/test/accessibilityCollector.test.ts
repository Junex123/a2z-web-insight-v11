import assert from "node:assert/strict";
import { test } from "node:test";
import { collectAccessibility } from "../src/collectors/accessibilityCollector.js";

test("detects a missing lang attribute", () => {
  const html = `<html><head><title>x</title></head><body></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.hasHtmlLangAttr, false);
  assert.equal(result.htmlLangValue, null);
});

test("detects a present lang attribute", () => {
  const html = `<html lang="en"><head><title>x</title></head><body></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.hasHtmlLangAttr, true);
  assert.equal(result.htmlLangValue, "en");
});

test("distinguishes 'no alt attribute' from 'alt=\"\"' (valid decorative marker)", () => {
  const html = `<html><body>
    <img src="a.png">
    <img src="b.png" alt="">
    <img src="c.png" alt="a real description">
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.images.total, 3);
  assert.equal(result.images.noAltAttribute, 1);
  assert.equal(result.images.emptyAlt, 1);
});

test("flags decorative images that contradict themselves with aria-label or a content role", () => {
  const html = `<html><body>
    <img src="a.png" alt="" aria-label="a real label">
    <img src="b.png" alt="" role="presentation">
    <img src="c.png" alt="">
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.images.emptyAlt, 3);
  assert.equal(result.images.suspiciousDecorative, 1, "only the aria-label contradiction should be flagged, not role=presentation");
});

test("detects unlabeled form controls, and correctly labeled ones are not flagged", () => {
  const html = `<html><body>
    <label for="name">Name</label><input id="name" type="text">
    <input type="email" placeholder="unlabeled">
    <label>Phone <input type="tel"></label>
    <input type="text" aria-label="Zip code">
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.formControls.total, 4);
  assert.equal(result.formControls.unlabeled, 1);
});

test("hidden inputs are excluded from form-control checks", () => {
  const html = `<html><body><input type="hidden" name="csrf"></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.formControls.total, 0);
});

test("detects buttons without accessible names", () => {
  const html = `<html><body>
    <button>Submit</button>
    <button></button>
    <button aria-label="Close"></button>
    <input type="submit" value="Go">
    <input type="button">
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.buttons.total, 5);
  assert.equal(result.buttons.withoutAccessibleName, 2);
});

test("detects links without accessible text, including image-only links with alt text", () => {
  const html = `<html><body>
    <a href="/a">Contact us</a>
    <a href="/b"></a>
    <a href="/c"><img src="icon.png" alt="Settings"></a>
    <a href="/d"><img src="icon.png"></a>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.links.total, 4);
  assert.equal(result.links.withoutAccessibleName, 2);
});

test("links without an href are not counted (not real navigable links)", () => {
  const html = `<html><body><a name="anchor">jump target</a></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.links.total, 0);
});

test("builds a full heading outline across all levels in document order", () => {
  const html = `<html><body><h1>Title</h1><h3>Sub</h3><h2>Section</h2></body></html>`;
  const result = collectAccessibility(html);
  assert.deepEqual(result.headingOutline, [
    { level: 1, text: "Title" },
    { level: 3, text: "Sub" },
    { level: 2, text: "Section" },
  ]);
});

test("detects duplicate id attributes", () => {
  const html = `<html><body>
    <div id="main"></div>
    <div id="main"></div>
    <div id="unique"></div>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.deepEqual(result.duplicateIds, ["main"]);
});

test("detects broken aria-labelledby/describedby references", () => {
  const html = `<html><body>
    <div id="real-label">Name</div>
    <input aria-labelledby="real-label">
    <input aria-labelledby="does-not-exist">
    <button aria-describedby="also-missing">Go</button>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.brokenAriaRefs.length, 2);
  assert.ok(result.brokenAriaRefs.some((r) => r.value === "does-not-exist"));
  assert.ok(result.brokenAriaRefs.some((r) => r.value === "also-missing"));
});

test("valid aria references are not flagged", () => {
  const html = `<html><body>
    <div id="lbl">Name</div>
    <input aria-labelledby="lbl">
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.brokenAriaRefs.length, 0);
});

test("detects invalid ARIA role values but not valid ones", () => {
  const html = `<html><body>
    <div role="button">ok</div>
    <div role="not-a-real-role">bad</div>
    <div role="banner region">multi-value with one valid token is fine</div>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.invalidAriaRoles.length, 1);
  assert.equal(result.invalidAriaRoles[0].role, "not-a-real-role");
});

test("detects a viewport that disables zoom", () => {
  const html = `<html><head><meta name="viewport" content="width=device-width, user-scalable=no"></head><body></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.viewportDisablesZoom, true);
});

test("a normal viewport does not trigger the zoom-disabled flag", () => {
  const html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.viewportDisablesZoom, false);
});

test("detects iframes missing a title", () => {
  const html = `<html><body>
    <iframe src="a.html" title="Support chat"></iframe>
    <iframe src="b.html"></iframe>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.iframes.total, 2);
  assert.equal(result.iframes.missingTitle, 1);
});

test("detects data tables with multiple rows/columns and no header cells", () => {
  const html = `<html><body>
    <table>
      <tr><td>A</td><td>B</td></tr>
      <tr><td>1</td><td>2</td></tr>
    </table>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.tables.total, 1);
  assert.equal(result.tables.withoutHeaders, 1);
});

test("a table that already has th cells is not flagged", () => {
  const html = `<html><body>
    <table>
      <tr><th>A</th><th>B</th></tr>
      <tr><td>1</td><td>2</td></tr>
    </table>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.tables.withoutHeaders, 0);
});

test("a simple 1x1 layout-style table is not flagged (avoids false positives)", () => {
  const html = `<html><body><table><tr><td>single cell</td></tr></table></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.tables.withoutHeaders, 0);
});

test("detects autoplaying media without controls or muted", () => {
  const html = `<html><body>
    <video src="a.mp4" autoplay></video>
    <video src="b.mp4" autoplay controls></video>
    <video src="c.mp4" autoplay muted></video>
    <audio src="d.mp3" autoplay></audio>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.autoplayMedia.total, 4);
  assert.equal(result.autoplayMedia.withoutControl, 2);
});

test("detects clickable non-interactive elements with no keyboard support", () => {
  const html = `<html><body>
    <div onclick="doThing()">click me</div>
    <span onclick="doThing()" role="button" tabindex="0">ok, has role+tabindex</span>
    <button onclick="doThing()">a real button is exempt</button>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.clickableNonInteractive.count, 1);
});

test("detects positive tabindex values but not tabindex=0 or -1", () => {
  const html = `<html><body>
    <div tabindex="3"></div>
    <div tabindex="0"></div>
    <div tabindex="-1"></div>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.positiveTabindex.count, 1);
});

test("a fully accessible page produces zero findings-worth of raw facts", () => {
  const html = `<html lang="en"><head><title>Accessible Page</title>
    <meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body>
    <h1>Welcome</h1>
    <h2>Section</h2>
    <img src="hero.png" alt="A friendly robot waving">
    <a href="/contact">Contact us</a>
    <button>Submit</button>
    <label for="email">Email</label><input id="email" type="email">
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.hasHtmlLangAttr, true);
  assert.equal(result.images.noAltAttribute, 0);
  assert.equal(result.images.suspiciousDecorative, 0);
  assert.equal(result.formControls.unlabeled, 0);
  assert.equal(result.buttons.withoutAccessibleName, 0);
  assert.equal(result.links.withoutAccessibleName, 0);
  assert.equal(result.duplicateIds.length, 0);
  assert.equal(result.brokenAriaRefs.length, 0);
  assert.equal(result.invalidAriaRoles.length, 0);
  assert.equal(result.viewportDisablesZoom, false);
  assert.equal(result.clickableNonInteractive.count, 0);
  assert.equal(result.positiveTabindex.count, 0);
});

test("empty/minimal HTML does not throw and returns sensible zeroed-out facts", () => {
  const result = collectAccessibility("");
  assert.equal(result.hasHtmlLangAttr, false);
  assert.equal(result.images.total, 0);
  assert.equal(result.formControls.total, 0);
  assert.equal(result.headingOutline.length, 0);
  assert.equal(result.duplicateIds.length, 0);
});

test("malformed/unclosed HTML does not throw and still extracts what it can", () => {
  const html = `<html lang="en"><body><div><img src="a.png"<p>broken tag soup</html>`;
  assert.doesNotThrow(() => collectAccessibility(html));
  const result = collectAccessibility(html);
  assert.equal(result.hasHtmlLangAttr, true);
});

// ---------------- Phase 2 additions ----------------

test("detects a <main> landmark", () => {
  const result = collectAccessibility(`<html><body><main>content</main></body></html>`);
  assert.equal(result.landmarks.mainCount, 1);
});

test("counts multiple <main> landmarks", () => {
  const result = collectAccessibility(`<html><body><main>a</main><main>b</main></body></html>`);
  assert.equal(result.landmarks.mainCount, 2);
});

test("detects a skip-navigation link by text content", () => {
  const result = collectAccessibility(`<html><body><a href="#main">Skip to content</a><main id="main"></main></body></html>`);
  assert.equal(result.landmarks.hasSkipLink, true);
});

test("does not treat an ordinary in-page anchor link as a skip link", () => {
  const result = collectAccessibility(`<html><body><a href="#section2">Read more</a></body></html>`);
  assert.equal(result.landmarks.hasSkipLink, false);
});

test("detects a heading with no accessible name", () => {
  const result = collectAccessibility(`<html><body><h1></h1></body></html>`);
  assert.equal(result.emptyHeadings.count, 1);
});

test("a heading with only an aria-label still has an accessible name", () => {
  const result = collectAccessibility(`<html><body><h1 aria-label="Welcome"></h1></body></html>`);
  assert.equal(result.emptyHeadings.count, 0);
});

test("flags related radio buttons not wrapped in fieldset/legend", () => {
  const html = `<html><body>
    <input type="radio" name="color" value="red">
    <input type="radio" name="color" value="blue">
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.fieldsetGrouping.ungroupedRadioCheckboxSets, 1);
});

test("does not flag radio buttons that ARE wrapped in fieldset/legend", () => {
  const html = `<html><body>
    <fieldset><legend>Favorite color</legend>
      <input type="radio" name="color" value="red">
      <input type="radio" name="color" value="blue">
    </fieldset>
  </body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.fieldsetGrouping.ungroupedRadioCheckboxSets, 0);
});

test("does not flag a single radio button with a unique name (no group)", () => {
  const html = `<html><body><input type="radio" name="agree" value="yes"></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.fieldsetGrouping.ungroupedRadioCheckboxSets, 0);
});

test("flags a fieldset with no legend", () => {
  const result = collectAccessibility(`<html><body><fieldset><input type="text"></fieldset></body></html>`);
  assert.equal(result.fieldsetGrouping.fieldsetsWithoutLegend, 1);
});

test("flags aria-invalid=true with no aria-describedby pointing at a real id", () => {
  const result = collectAccessibility(`<html><body><input aria-invalid="true"></body></html>`);
  assert.equal(result.errorAssociation.unassociatedCount, 1);
});

test("does not flag aria-invalid=true when aria-describedby resolves to a real id", () => {
  const html = `<html><body><input aria-invalid="true" aria-describedby="err1"><span id="err1">Required field</span></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.errorAssociation.unassociatedCount, 0);
});

test("does not flag aria-invalid=false", () => {
  const result = collectAccessibility(`<html><body><input aria-invalid="false"></body></html>`);
  assert.equal(result.errorAssociation.unassociatedCount, 0);
});

test("flags disabled + aria-disabled=false as a contradiction", () => {
  const result = collectAccessibility(`<html><body><button disabled aria-disabled="false">Save</button></body></html>`);
  assert.equal(result.disabledStateContradictions.count, 1);
});

test("does not flag disabled alone (no aria-disabled present)", () => {
  const result = collectAccessibility(`<html><body><button disabled>Save</button></body></html>`);
  assert.equal(result.disabledStateContradictions.count, 0);
});

test("flags an ARIA interactive-widget role with no tabindex on a non-native element", () => {
  const result = collectAccessibility(`<html><body><div role="button">Click me</div></body></html>`);
  assert.equal(result.ariaWidgetsNotFocusable.count, 1);
});

test("does not flag an ARIA widget role that has tabindex=0", () => {
  const result = collectAccessibility(`<html><body><div role="button" tabindex="0">Click me</div></body></html>`);
  assert.equal(result.ariaWidgetsNotFocusable.count, 0);
});

test("does not flag tabindex=-1 on an ARIA widget (roving-tabindex pattern)", () => {
  const result = collectAccessibility(`<html><body><div role="tab" tabindex="-1">Tab 1</div></body></html>`);
  assert.equal(result.ariaWidgetsNotFocusable.count, 0);
});

test("does not flag role=button on a native <button> element", () => {
  const result = collectAccessibility(`<html><body><button role="button">Click me</button></body></html>`);
  assert.equal(result.ariaWidgetsNotFocusable.count, 0);
});

// ---------------- Session 8: dialog/modal static markup ----------------

test("counts role=dialog and native <dialog> elements as dialogs", () => {
  const result = collectAccessibility(`<html><body><div role="dialog"></div><dialog></dialog></body></html>`);
  assert.equal(result.dialogs.total, 2);
});

test("flags a dialog with no aria-label/aria-labelledby/title as unnamed", () => {
  const result = collectAccessibility(`<html><body><div role="dialog"><p>Some content</p></div></body></html>`);
  assert.equal(result.dialogs.withoutAccessibleName.count, 1);
});

test("does not flag a dialog with aria-label as unnamed", () => {
  const result = collectAccessibility(`<html><body><div role="dialog" aria-label="Confirm delete"></div></body></html>`);
  assert.equal(result.dialogs.withoutAccessibleName.count, 0);
});

test("does not flag a dialog whose aria-labelledby resolves to a real heading", () => {
  const html = `<html><body><div role="dialog" aria-labelledby="dtitle"><h2 id="dtitle">Confirm delete</h2></div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.dialogs.withoutAccessibleName.count, 0);
});

test("a dialog's plain visible text content alone does NOT count as an accessible name", () => {
  // deliberately different from hasAccessibleName()'s generic text fallback used for buttons/links -
  // a dialog full of body copy isn't "named" by that copy per the ARIA accessible-name spec
  const html = `<html><body><div role="dialog">Please confirm you want to delete this item permanently.</div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.dialogs.withoutAccessibleName.count, 1);
});

test("flags a dialog with no focusable/interactive content in its markup", () => {
  const html = `<html><body><div role="dialog" aria-label="Loading"><p>Please wait...</p></div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.dialogs.withoutFocusableContent.count, 1);
});

test("does not flag a dialog that contains a real close button", () => {
  const html = `<html><body><div role="dialog" aria-label="Confirm"><button>Close</button></div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.dialogs.withoutFocusableContent.count, 0);
});

test("a dialog with an element that has tabindex counts as having focusable content", () => {
  const html = `<html><body><div role="dialog" aria-label="Confirm"><div tabindex="0">OK</div></div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.dialogs.withoutFocusableContent.count, 0);
});

// ---------------- Session 9: skip-link target resolution ----------------

test("flags a skip link whose target id does not exist on the page", () => {
  const html = `<html><body><a href="#main">Skip to content</a><p>no element with id=main here</p></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.landmarks.skipLinkTargetMissing, true);
});

test("does not flag a skip link whose target id exists", () => {
  const html = `<html><body><a href="#main">Skip to content</a><main id="main"></main></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.landmarks.skipLinkTargetMissing, false);
});

test("flags a skip link whose target has the hidden attribute", () => {
  const html = `<html><body><a href="#main">Skip to content</a><main id="main" hidden></main></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.landmarks.skipLinkTargetHidden, true);
});

test("flags a skip link whose target has an aria-hidden ancestor", () => {
  const html = `<html><body><a href="#main">Skip to content</a><div aria-hidden="true"><main id="main"></main></div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.landmarks.skipLinkTargetHidden, true);
});

test("does not flag a skip link whose visible target is not hidden", () => {
  const html = `<html><body><a href="#main">Skip to content</a><main id="main"><p>content</p></main></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.landmarks.skipLinkTargetHidden, false);
});

test("skip-link target fields stay false/absent-equivalent when there is no skip link at all", () => {
  const html = `<html><body><p>No skip link here.</p></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.landmarks.hasSkipLink, false);
  assert.equal(result.landmarks.skipLinkTargetMissing, false);
  assert.equal(result.landmarks.skipLinkTargetHidden, false);
});

// ---------------- Session 9: broken label[for] associations ----------------

test("flags a label whose for attribute references a nonexistent id", () => {
  const html = `<html><body><label for="emial">Email</label><input id="email" type="email"></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.brokenLabelAssociations.count, 1);
});

test("does not flag a label whose for attribute correctly resolves", () => {
  const html = `<html><body><label for="email">Email</label><input id="email" type="email"></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.brokenLabelAssociations.count, 0);
});

test("does not flag a label with no for attribute at all (wrapping pattern)", () => {
  const html = `<html><body><label>Email <input type="email"></label></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.brokenLabelAssociations.count, 0);
});

// ---------------- Session 9: aria-hidden hiding focusable content ----------------

test("flags aria-hidden=true on an element that is itself focusable", () => {
  const html = `<html><body><button aria-hidden="true">Hidden but focusable</button></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.ariaHiddenFocusable.count, 1);
});

test("flags aria-hidden=true on a container with a focusable descendant", () => {
  const html = `<html><body><div aria-hidden="true"><a href="/somewhere">Link</a></div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.ariaHiddenFocusable.count, 1);
});

test("does not flag aria-hidden=true on purely decorative, non-focusable content", () => {
  const html = `<html><body><span aria-hidden="true">★</span></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.ariaHiddenFocusable.count, 0);
});

test("does not flag aria-hidden=true when the focusable descendant has tabindex=-1", () => {
  const html = `<html><body><div aria-hidden="true"><div tabindex="-1">Removed from tab order</div></div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.ariaHiddenFocusable.count, 0);
});

// ---------------- Session 9: duplicate/conflicting landmark labels ----------------

test("flags two <nav> elements with no distinguishing label", () => {
  const html = `<html><body><nav><a href="/a">A</a></nav><nav><a href="/b">B</a></nav></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.duplicateLandmarks.ambiguousCount, 1);
});

test("does not flag two <nav> elements that each have a distinct aria-label", () => {
  const html = `<html><body><nav aria-label="Primary"><a href="/a">A</a></nav><nav aria-label="Footer"><a href="/b">B</a></nav></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.duplicateLandmarks.ambiguousCount, 0);
  assert.equal(result.duplicateLandmarks.conflictingLabelCount, 0);
});

test("flags two <nav> elements that share the exact same label", () => {
  const html = `<html><body><nav aria-label="Menu"><a href="/a">A</a></nav><nav aria-label="Menu"><a href="/b">B</a></nav></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.duplicateLandmarks.conflictingLabelCount, 1);
});

test("does not flag a single <nav> element (nothing to compare against)", () => {
  const html = `<html><body><nav><a href="/a">A</a></nav></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.duplicateLandmarks.ambiguousCount, 0);
});

test("does not treat a <header> nested inside an <article> as a duplicate page-level banner landmark", () => {
  const html = `<html><body>
    <header>Site header</header>
    <article><header>Article header</header></article>
  </body></html>`;
  const result = collectAccessibility(html);
  // only ONE real page-level banner landmark (the article's header isn't one) - no duplication to flag
  assert.equal(result.duplicateLandmarks.ambiguousCount, 0);
});


test("does not flag aria-hidden=true when a naturally focusable element has tabindex=-1", () => {
  const html = `<html><body><div aria-hidden="true"><a href="/somewhere" tabindex="-1">Explicitly removed link</a></div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.ariaHiddenFocusable.count, 0);
});

test("three unlabeled <nav> elements still count as one ambiguous group", () => {
  const html = `<html><body><nav>A</nav><nav>B</nav><nav>C</nav></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.duplicateLandmarks.ambiguousCount, 1);
});

test("detects redundant native ARIA roles", () => {
  const html = `<html><body><button role="button">Save</button><nav role="navigation"></nav></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.redundantAriaRoles.count, 2);
});

test("does not flag a custom role=button on a non-native element as redundant", () => {
  const html = `<html><body><div role="button" tabindex="0">Click</div></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.redundantAriaRoles.count, 0);
});

test("does not flag nested header role=banner as redundant page-level banner semantics", () => {
  const html = `<html><body><article><header role="banner">Article</header></article></body></html>`;
  const result = collectAccessibility(html);
  assert.equal(result.redundantAriaRoles.count, 0);
});
