import re

# ---------- 1. treeNodeGroup.ts 补组类型（i18n 翻译） ----------
p = "apps/desktop/src/lib/sidebar/treeNodeGroup.ts"
s = open(p, encoding="utf-8").read()
old = """  "group-partitions",
  "group-extensions",
]);"""
assert old in s, "treeGroup types"
s = s.replace(old, """  "group-partitions",
  "group-extensions",
  "group-references",
  "group-referenced-by",
]);""")
open(p, "w", encoding="utf-8").write(s)
print("1 treeNodeGroup fixed")

# ---------- 2/3/4. connectionStore.ts ----------
p = "apps/desktop/src/stores/connectionStore.ts"
s = open(p, encoding="utf-8").read()

# 2a. 包展开恢复：loadOpengaussPackageSubprograms 后追加引用组（不覆盖子程序）
old = """    } else if ((node.type === "package" || node.type === "package-body") && node.connectionId && hasTreeNodeDatabaseContext(node) && node.objectName) {
      await loadOpengaussPackageSubprograms(node.connectionId, node.database, node.objectName, node.schema, node.id);
    } else if (objectTypesForGroupNode(node.type)) {"""
assert old in s, "package branch"
new = """    } else if ((node.type === "package" || node.type === "package-body") && node.connectionId && hasTreeNodeDatabaseContext(node) && node.objectName) {
      await loadOpengaussPackageSubprograms(node.connectionId, node.database, node.objectName, node.schema, node.id);
      const config = getConfig(node.connectionId);
      if (isOpengaussFamilyConfig(config)) {
        const live = findNode(treeNodes.value, node.id);
        if (live) {
          live.children = [
            ...(live.children ?? []),
            ...buildObjectReferenceGroupNodes(node, node.type === "package" ? "package" : "package", node.objectName, "references", true),
            ...buildObjectReferenceGroupNodes(node, "package", node.objectName, "referencedBy", true),
          ];
        }
      }
    } else if (objectTypesForGroupNode(node.type)) {"""
s = s.replace(old, new)

# 2b. 新非表对象分支：去掉 package（交回原逻辑）；function/procedure/sequence 用 objectName
old2 = """    } else if ((node.type === "sequence" || node.type === "function" || node.type === "procedure" || node.type === "package") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      const config = getConfig(node.connectionId);
      if (isOpengaussFamilyConfig(config)) {
        await loadRoutineReferenceGroups(node, node.type, node.label);
      }
    }"""
assert old2 in s, "new branch"
new2 = """    } else if ((node.type === "sequence" || node.type === "function" || node.type === "procedure") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      const config = getConfig(node.connectionId);
      if (isOpengaussFamilyConfig(config)) {
        const objectName = node.objectName || node.label;
        await loadRoutineReferenceGroups(node, node.type, objectName);
      }
    }"""
s = s.replace(old2, new2)

# 2c. 同义词：去掉 referencedBy（openGauss 不记录同义词被引用）
old3 = """      if (target && (target.targetKind === "r" || target.targetKind === "v" || target.targetKind === "m")) {
      // The target is a table/view/materialized view: reuse the table-style
      // child groups (columns/indexes/fks/triggers/partitions) then append the
      // synonym-level reference groups.
      await loadTableGroups(connectionId, database, target.targetName, target.targetSchema, node.id, undefined, synonymTargetObjectType(target.targetKind));
      const live = findNode(treeNodes.value, node.id);
      if (live) {
        live.children = [
          ...(live.children ?? []),
          ...buildObjectReferenceGroupNodes(node, "synonym", synonym, "references", true),
          ...buildObjectReferenceGroupNodes(node, "synonym", synonym, "referencedBy", true),
        ];
      }
      return;
    }"""
assert old3 in s, "synonym table"
new3 = """      if (target && (target.targetKind === "r" || target.targetKind === "v" || target.targetKind === "m")) {
      // The target is a table/view/materialized view: reuse the table-style
      // child groups (columns/indexes/fks/triggers/partitions) then append the
      // synonym-level reference group.
      await loadTableGroups(connectionId, database, target.targetName, target.targetSchema, node.id, undefined, synonymTargetObjectType(target.targetKind));
      const live = findNode(treeNodes.value, node.id);
      if (live) {
        live.children = [
          ...(live.children ?? []),
          ...buildObjectReferenceGroupNodes(node, "synonym", synonym, "references", true),
        ];
      }
      return;
    }"""
s = s.replace(old3, new3)
# 同义词非表目标分支也去掉 referencedBy
old4 = """      const children: TreeNode[] = [
        ...buildObjectReferenceGroupNodes(node, "synonym", synonym, "references", true),
        ...buildObjectReferenceGroupNodes(node, "synonym", synonym, "referencedBy", true),
      ];"""
assert old4 in s, "synonym leaf"
s = s.replace(old4, """      const children: TreeNode[] = [
        ...buildObjectReferenceGroupNodes(node, "synonym", synonym, "references", true),
      ];""")
open(p, "w", encoding="utf-8").write(s)
print("2/3/4 connectionStore fixed")
