import * as d3dag from "https://cdn.skypack.dev/d3-dag@1.0.0-1";

/**
 * Collapse visual groups into single layout nodes for Sugiyama, then expand
 * member courses to a vertical stack at the layout anchor.
 */

function resolveLayoutId(nodeId, nodeToGroupId) {
  return nodeToGroupId.get(nodeId) ?? nodeId;
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
    });
  }

  return layoutNodes;
}

export function stackedGroupHeight(memberCount, nodeH, gap) {
  if (memberCount < 1) return nodeH;
  return memberCount * nodeH + (memberCount - 1) * gap;
}

/** Sugiyama nodeSize: groups consume vertical space matching the post-layout stack. */
export function createLayoutNodeSize(nodeW, nodeH, gap) {
  return (node) => {
    const count = node.data.memberCount ?? 1;
    return [nodeW, stackedGroupHeight(count, nodeH, gap)];
  };
}

/**
 * Stratify all courses, copy (x, y) from the collapsed layout graph.
 * Group members are stacked vertically at the group's layout anchor.
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

    const stackH = stackedGroupHeight(members.length, nodeH, gap);
    let y = anchor.y - stackH / 2 + nodeH / 2;

    for (const node of members) {
      node.x = anchor.x;
      node.y = y;
      y += nodeH + gap;
    }
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
