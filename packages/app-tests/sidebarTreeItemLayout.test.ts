import { test } from "vitest";
import assert from "node:assert/strict";
import { canTreeNodePin, canTreeNodeShowExpander, treeLabelWidthClass } from "../../apps/desktop/src/lib/sidebar/sidebarTreeItemLayout.ts";

test("mongodb collection rows can show an expander for metadata groups", () => {
  assert.equal(canTreeNodeShowExpander({ type: "mongo-collection", childCount: 0 }), true);
});


test("openGauss package and package body rows show an expander for subprograms", () => {
  assert.equal(canTreeNodeShowExpander({ type: "package", childCount: 0 }), true);
  assert.equal(canTreeNodeShowExpander({ type: "package-body", childCount: 0 }), true);
});


test("labels with trailing comments consume the available row width when aligned", () => {
  assert.equal(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: true, alignLeading: true }), "min-w-0 flex-1 truncate");
  // inline/right 模式 label 不撑满，让 comment 紧跟
  assert.equal(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: true, alignLeading: false }), "min-w-0 shrink truncate");
  assert.equal(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: false }), "min-w-0 truncate");
});

test("horizontal-scroll labels keep their intrinsic width", () => {
  assert.equal(treeLabelWidthClass({ fullWidth: true, hasTrailingComment: true }), "shrink-0 whitespace-nowrap");
});
