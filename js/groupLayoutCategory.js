import * as d3dag from "https://cdn.skypack.dev/d3-dag@1.0.0-1";

function resolveLayoutId(nodeId, nodeToGroupId) {
  return nodeToGroupId.get(nodeId) ?? nodeId;
}

export function groupRole(group) {
  if (group.role) return group.role;
  if (!(group.parentIds || []).length) return 'root';
  if (!(group.childIds || []).length) return 'leaf';
  return 'interior';
}

/**
 * Calculates grid layout dimensions.
 * By default: groups with > 3 members split into 2 columns (this is the
 * original behavior, unchanged, used by process-based majors like
 * Chemistry). An optional `colsFn(memberCount) -> number` lets callers
 * (e.g. category-based majors, where a single category box might hold 15+
 * courses) use a different column strategy without touching this default.
 */
function getGridDimensions(memberCount, colsFn) {
  const cols = colsFn ? colsFn(memberCount) : (memberCount > 3 ? 2 : 1);
  const rows = Math.ceil(memberCount / cols);
  return { rows, cols };
}

/** Computes the total height of the cluster bounding box based on rows */
export function stackedGroupHeight(memberCount, nodeH, gap, colsFn) {
  if (memberCount < 1) return nodeH;
  const { rows } = getGridDimensions(memberCount, colsFn);
  return rows * nodeH + (rows - 1) * gap;
}

/** Computes the total width of the cluster bounding box based on columns */
export function stackedGroupWidth(memberCount, nodeW, gap, colsFn) {
  if (memberCount < 1) return nodeW;
  const { cols } = getGridDimensions(memberCount, colsFn);
  return cols * nodeW + (cols - 1) * gap;
}

/** * Updates Sugiyama slot sizing to reflect the true 2D width and height 
 * of our new boxy grid structures.
 */
export function createRoleAwareLayoutNodeSize(nodeW, nodeH, gap, colsFn) {
  return (node) => {
    const count = node.data.memberCount ?? 1;
    return [
      stackedGroupWidth(count, nodeW, gap, colsFn),
      stackedGroupHeight(count, nodeH, gap, colsFn)
    ];
  };
}

/**
 * High-level descriptor builder for Phase 2 graph stratification.
 * (Process-based majors: clusterNodes.js only ever groups nodes that
 * already share identical parent/child sets, so a group's own parentIds
 * can never point back at itself — no cycle-guarding needed here.)
 */
export function buildLayoutNodes(courses, visualGroups, nodeToGroupId) {
  const inGroup = new Set(nodeToGroupId.keys());
  const layoutNodes = [];

  for (const group of visualGroups) {
    const parentIds = [
      ...new Set((group.parentIds || []).map(id => resolveLayoutId(id, nodeToGroupId))),
    ];
    layoutNodes.push({
      id: group.id,
      parentIds,
      isLayoutGroup: true,
      memberCount: group.memberIds.length,
      role: groupRole(group),
    });
  }

  for (const course of courses) {
    if (inGroup.has(course.id)) continue;
    const parentIds = [
      ...new Set((course.parentIds || []).map(id => resolveLayoutId(id, nodeToGroupId))),
    ];
    layoutNodes.push({
      id: course.id,
      parentIds,
      isLayoutGroup: false,
      memberCount: 1,
      role: 'singleton',
    });
  }

  return layoutNodes;
}

/**
 * Feedback-arc-set style cycle breaker for the collapsed layout graph.
 *
 * Category-based clustering can legitimately introduce parent/child edges
 * BETWEEN categories (e.g. "seminar" depends on "methodology" because
 * several seminars require POL 182). d3-dag's stratify() requires a true
 * DAG, so if two categories ever depended on each other (directly or
 * through a chain) this would break layout. This performs a DFS over the
 * candidate edges and drops the specific edge that would close a cycle,
 * keeping the graph a valid DAG while preserving everything else.
 */
function detectAndDropCyclicEdges(nodeList) {
  const byId = new Map(nodeList.map(n => [n.id, n]));
  const state = new Map(); // 0/undefined = unvisited, 1 = in progress, 2 = done
  const dropped = new Set(); // keys "parentId->id" to remove

  function visit(id) {
    state.set(id, 1);
    const node = byId.get(id);
    if (node) {
      for (const parentId of node.parentIds) {
        if (!byId.has(parentId)) continue; // parent outside this node set is fine
        const parentState = state.get(parentId) || 0;
        if (parentState === 1) {
          // parentId is currently an ancestor of id => id -> parentId would
          // close a cycle. Drop this specific dependency.
          dropped.add(`${parentId}->${id}`);
        } else if (parentState === 0) {
          visit(parentId);
        }
      }
    }
    state.set(id, 2);
  }

  nodeList.forEach(n => {
    if ((state.get(n.id) || 0) === 0) visit(n.id);
  });

  if (dropped.size === 0) return nodeList;

  return nodeList.map(n => ({
    ...n,
    parentIds: n.parentIds.filter(pid => !dropped.has(`${pid}->${n.id}`)),
  }));
}

/**
 * Category-aware counterpart to buildLayoutNodes(). Two differences from
 * the process-based version:
 *   1. A category's own members frequently point back at other members of
 *      the SAME category (e.g. POL 363 requires POL 161, both
 *      "international-politics") — that resolves to a self-loop once
 *      collapsed, so self-references are filtered out here.
 *   2. Categories can depend on each other in ways that (in principle)
 *      could form a cycle across categories; detectAndDropCyclicEdges()
 *      guards against that so stratify() always receives a valid DAG.
 */
export function buildCategoryLayoutNodes(courses, visualGroups, nodeToGroupId) {
  const inGroup = new Set(nodeToGroupId.keys());
  const rawNodes = [];

  for (const group of visualGroups) {
    const parentIds = new Set();
    (group.parentIds || []).forEach(id => {
      const resolved = resolveLayoutId(id, nodeToGroupId);
      if (resolved !== group.id) parentIds.add(resolved);
    });
    rawNodes.push({
      id: group.id,
      parentIds: [...parentIds],
      isLayoutGroup: true,
      memberCount: group.memberIds.length,
      role: groupRole(group),
    });
  }

  for (const course of courses) {
    if (inGroup.has(course.id)) continue;
    const parentIds = new Set();
    (course.parentIds || []).forEach(id => {
      const resolved = resolveLayoutId(id, nodeToGroupId);
      if (resolved !== course.id) parentIds.add(resolved);
    });
    rawNodes.push({
      id: course.id,
      parentIds: [...parentIds],
      isLayoutGroup: false,
      memberCount: 1,
      role: 'singleton',
    });
  }

  return detectAndDropCyclicEdges(rawNodes);
}

/**
 * Places group members inside their assigned layout slots.
 * Arranges nodes left-to-right, then top-to-bottom within the box.
 */
export function placeGroupStack(members, anchor, role, nodeH, gap, nodeW, colsFn) {
  if (members.length === 0) return;

  const { rows, cols } = getGridDimensions(members.length, colsFn);
  const totalW = cols * nodeW + (cols - 1) * gap;
  const totalH = rows * nodeH + (rows - 1) * gap;

  // Center the grid coordinates directly over the layout anchor point
  const startX = anchor.x - totalW / 2 + nodeW / 2;
  const startY = anchor.y - totalH / 2 + nodeH / 2;

  members.forEach((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);

    node.x = startX + col * (nodeW + gap);
    node.y = startY + row * (nodeH + gap);
  });
}

/**
 * Expands layout coordinates back to all independent courses.
 * `colsFn` (optional) is forwarded to placeGroupStack for majors whose
 * category boxes need a different column strategy than the 1/2-column
 * default.
 */
export function expandLayoutToCourseGraph(
  courses,
  layoutGraph,
  visualGroups,
  nodeToGroupId,
  { nodeW, nodeH, gap, colsFn },
) {
  const stratify = d3dag.graphStratify()
    .id(d => d.id)
    .parentIds(d => d.parentIds || []);

  const graph = stratify(courses);
  const layoutById = new Map(layoutGraph.nodes().map(n => [n.data.id, n]));
  const courseById = new Map(graph.nodes().map(n => [n.data.id, n]));

  for (const group of visualGroups) {
    const anchor = layoutById.get(group.id);
    if (!anchor) continue;

    const members = group.memberIds
      .map(id => courseById.get(id))
      .filter(Boolean)
      .sort((a, b) => a.data.id.localeCompare(b.data.id));

    placeGroupStack(members, anchor, groupRole(group), nodeH, gap, nodeW, colsFn);
  }

  for (const node of graph.nodes()) {
    if (nodeToGroupId.has(node.data.id)) continue;
    const anchor = layoutById.get(node.data.id);
    if (anchor) {
      node.x = anchor.x;
      node.y = anchor.y;
    }
  }

  return graph;
}

/** Fitting helper logic to prevent clipping windows */
export function fitGraphToViewport(graph, nodeW, nodeH, padX = 24, padTop = 32, padBottom = 48) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of graph.nodes()) {
    minX = Math.min(minX, node.x - nodeW / 2);
    maxX = Math.max(maxX, node.x + nodeW / 2);
    minY = Math.min(minY, node.y - nodeH / 2);
    maxY = Math.max(maxY, node.y + nodeH / 2);
  }

  if (!Number.isFinite(minX)) {
    return { width: 0, height: 0, dx: 0, dy: 0 };
  }

  const dx = padX - minX;
  const dy = padTop - minY;

  for (const node of graph.nodes()) {
    node.x += dx;
    node.y += dy;
  }

  for (const link of graph.links()) {
    if (!link.points) continue;
    for (const pt of link.points) {
      pt[0] += dx;
      pt[1] += dy;
    }
  }

  return {
    width: maxX - minX + padX * 2,
    height: maxY - minY + padTop + padBottom,
    dx,
    dy,
  };
}

export { resolveLayoutId };
