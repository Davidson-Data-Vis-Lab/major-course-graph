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
 * For groups with > 3 members, it splits them into 2 columns.
 */
function getGridDimensions(memberCount) {
  const cols = memberCount > 3 ? 2 : 1; 
  const rows = Math.ceil(memberCount / cols);
  return { rows, cols };
}

/** Computes the total height of the cluster bounding box based on rows */
export function stackedGroupHeight(memberCount, nodeH, gap) {
  if (memberCount < 1) return nodeH;
  const { rows } = getGridDimensions(memberCount);
  return rows * nodeH + (rows - 1) * gap;
}

/** Computes the total width of the cluster bounding box based on columns */
export function stackedGroupWidth(memberCount, nodeW, gap) {
  if (memberCount < 1) return nodeW;
  const { cols } = getGridDimensions(memberCount);
  return cols * nodeW + (cols - 1) * gap;
}

/** * Updates Sugiyama slot sizing to reflect the true 2D width and height 
 * of our new boxy grid structures.
 */
export function createRoleAwareLayoutNodeSize(nodeW, nodeH, gap) {
  return (node) => {
    const count = node.data.memberCount ?? 1;
    return [
      stackedGroupWidth(count, nodeW, gap),
      stackedGroupHeight(count, nodeH, gap)
    ];
  };
}

/**
 * High-level descriptor builder for Phase 2 graph stratification.
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
 * Places group members inside their assigned layout slots.
 * Arranges nodes left-to-right, then top-to-bottom within the box.
 */
export function placeGroupStack(members, anchor, role, nodeH, gap, nodeW) {
  if (members.length === 0) return;

  const { rows, cols } = getGridDimensions(members.length);
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
 */
export function expandLayoutToCourseGraph(
  courses,
  layoutGraph,
  visualGroups,
  nodeToGroupId,
  { nodeW, nodeH, gap }, 
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

    placeGroupStack(members, anchor, groupRole(group), nodeH, gap, nodeW);
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