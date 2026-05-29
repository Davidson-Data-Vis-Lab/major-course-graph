import * as d3dag from "https://cdn.skypack.dev/d3-dag@1.0.0-1";

/**
 * Collapse visual groups into single layout nodes for Sugiyama, then expand
 * member courses. Groups are only roots or leaves: layout uses one slot per
 * node; stacks grow into top/bottom margin instead of inflating every layer.
 */

function resolveLayoutId(nodeId, nodeToGroupId) {
  return nodeToGroupId.get(nodeId) ?? nodeId;
}

export function groupRole(group) {
  if (group.role) return group.role;
  if (!(group.parentIds || []).length) return 'root';
  if (!(group.childIds || []).length) return 'leaf';
  return 'interior';
}

/** Nodes fed to graphStratify — one row per layout slot (group or ungrouped course). */
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

export function stackedGroupHeight(memberCount, nodeH, gap) {
  if (memberCount < 1) return nodeH;
  return memberCount * nodeH + (memberCount - 1) * gap;
}

/**
 * Sugiyama slot heights: roots reserve their full stack (pushes layer 1 down);
 * leaves and singletons use one slot (stack grows into bottom margin after layout).
 */
export function createRoleAwareLayoutNodeSize(nodeW, nodeH, gap) {
  return (node) => {
    const count = node.data.memberCount ?? 1;
    if (node.data.role === 'root') {
      return [nodeW, stackedGroupHeight(count, nodeH, gap)];
    }
    return [nodeW, nodeH];
  };
}

/**
 * Place group members in the layout slot.
 * - root: fill the tall reserved box (top-to-bottom)
 * - leaf: top member at anchor, stack into bottom margin
 */
export function placeGroupStack(members, anchor, role, nodeH, gap) {
  if (members.length === 0) return;

  if (role === 'root') {
    const stackH = stackedGroupHeight(members.length, nodeH, gap);
    let y = anchor.y - stackH / 2 + nodeH / 2;
    for (const node of members) {
      node.x = anchor.x;
      node.y = y;
      y += nodeH + gap;
    }
    return;
  }

  let y = anchor.y;
  for (const node of members) {
    node.x = anchor.x;
    node.y = y;
    y += nodeH + gap;
  }
}

/**
 * Stratify all courses, copy (x, y) from the collapsed layout graph.
 */
export function expandLayoutToCourseGraph(
  courses,
  layoutGraph,
  visualGroups,
  nodeToGroupId,
  { nodeH, gap },
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

    placeGroupStack(members, anchor, groupRole(group), nodeH, gap);
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

/** Shift so content fits [padX, padTop].. and return pixel width/height. */
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
