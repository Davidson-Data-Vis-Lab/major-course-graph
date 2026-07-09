/**
 * clusterNodesCategory.js
 * ------------------------------------------------------------------------
 * Category-based counterpart to clusterNodes.js.
 *
 * clusterNodes.js clusters courses that share the exact same set of parents
 * AND children (or, for leaves, just the same parents). That's the right
 * heuristic for a *process-based* major like Chemistry, where the graph
 * really is a prerequisite chain and "same parents/children" reliably finds
 * duplicate/interchangeable course slots.
 *
 * A *category-based* major like Political Science doesn't work that way.
 * Most courses have zero or one prerequisite (parentIds is usually []), so
 * "same parents and children" would either match almost nothing, or lump
 * every parent-less course into one giant blob. What actually organizes
 * these majors is an explicit `group` field on each course (e.g.
 * "american-politics", "comparative-politics", "seminar", "elective") —
 * a subject-area tag, not a dependency.
 *
 * This module clusters courses by that tag instead:
 *   1. A course's `group` field is split on commas, since a course can carry
 *      more than one tag (e.g. "cultural_diversity, american-politics").
 *   2. The course is PLACED in the first non-"cultural_diversity" tag it
 *      has (cultural_diversity is treated as a cross-cutting label, not a
 *      placement bucket, unless it's the only tag present).
 *   3. Every category with at least one course becomes one visual group
 *      (a "box" in the diagram) — unlike clusterNodes.js, a category with
 *      only one member still gets its own group, since the goal here is
 *      visual organization by subject area, not de-duplication.
 *   4. Each category's parentIds is the UNION of the real parentIds of all
 *      its members (deduplicated), which lets groupLayoutCategory-style
 *      layout figure out real cross-category dependencies (e.g. "seminar"
 *      sits below "methodology" because several seminars require POL 182).
 *
 * The PRQ -> edge-style parsing (solid vs. dashed lines for AND/OR
 * prerequisites) is identical to clusterNodes.js, so link rendering in
 * main.js/mainCategory.js behaves the same either way.
 */

/** Splits a raw `group` string into individual trimmed tags. */
function normalizeGroupTags(rawGroup) {
  if (!rawGroup) return [];
  return rawGroup.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Picks the tag used to actually place (cluster) a course.
 * "cultural_diversity" is cross-cutting: if present alongside another tag,
 * the other tag wins placement and cultural_diversity is just metadata.
 * Returns null for courses with no group (they stay ungrouped/standalone).
 */
function primaryCategory(rawGroup) {
  const tags = normalizeGroupTags(rawGroup);
  if (tags.length === 0) return null;
  const nonDiversity = tags.find(t => t !== 'cultural_diversity');
  return nonDiversity || tags[0];
}

function clusterNodesCategory(nodes) {
  // Edge styling (solid/dashed) works exactly like the process-based version.
  const edgeMap = new Map();
  nodes.forEach(node => determineParentEdgeType(node, edgeMap));

  // Bucket courses by their placement category.
  const categoryMembers = new Map(); // category string -> [course, ...]
  nodes.forEach(node => {
    const category = primaryCategory(node.group);
    if (!category) return; // no tag => stays a standalone layout node
    if (!categoryMembers.has(category)) categoryMembers.set(category, []);
    categoryMembers.get(category).push(node);
  });

  const visualGroups = [];
  const nodeToGroupId = new Map();

  categoryMembers.forEach((members, category) => {
    const groupId = `category_${category}`;

    const parentIdSet = new Set();
    members.forEach(n => (n.parentIds || []).forEach(id => parentIdSet.add(id)));

    visualGroups.push({
      id: groupId,
      reason: 'category',
      category,
      members,
      memberIds: members.map(n => n.id),
      parentIds: [...parentIdSet],
      childIds: [], // categories don't have a single clean child set; unused by layout
    });

    members.forEach(n => nodeToGroupId.set(n.id, groupId));
  });

  return { visualGroups, nodeToGroupId, edgeMap };
}

// ---- PRQ token parsing (identical logic to clusterNodes.js) ----

function findMatching(tokens, i) {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j] === '(') depth++;
    else if (tokens[j] === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  throw new Error(`Unmatched "(" at ${i}`);
}

function parseGroup(tokens, target) {
  const hasOr = tokens.includes('or');
  const hasAnd = tokens.includes('and');
  const style = !hasOr ? 'solid' : (!hasAnd ? 'dashed' : 'solid');
  let out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '(') {
      const j = findMatching(tokens, i);
      out.push(...parseGroup(tokens.slice(i + 1, j), target));
      i = j + 1;
    } else if (t === 'and' || t === 'or' || t === ')') {
      i++;
    } else {
      out.push({ source: t, target, style });
      i++;
    }
  }
  return out;
}

function determineParentEdgeType(node, edgeMap) {
  const incomingEdgesList = parseGroup(node.PRQ || [], node.id);
  for (const { source, target, style } of incomingEdgesList) {
    if (!edgeMap.has(source)) edgeMap.set(source, []);
    edgeMap.get(source).push({ target, style });
  }
}

export { clusterNodesCategory, primaryCategory, normalizeGroupTags };
