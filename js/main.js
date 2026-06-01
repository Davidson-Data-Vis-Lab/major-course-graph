console.log("main.js is running...");
/**
 * Based on Erik Brinkman's https://codepen.io/brinkbot/pen/oNQwNRv
 * 
 * 
 */

import * as d3 from "https://cdn.skypack.dev/d3@7.8.4";
window.d3 = d3;
import * as d3dag from "https://cdn.skypack.dev/d3-dag@1.0.0-1";
import { clusterNodes } from './clusterNodes.js';
import {
  buildLayoutNodes,
  createRoleAwareLayoutNodeSize,
  expandLayoutToCourseGraph,
  fitGraphToViewport,
} from './groupLayout.js';

const data = await d3.json("data/courses-full-info.json");


// ------------------- //
// Phase 1: Grouping   //
// ------------------- //
// computeVisualGroups returns metadata only — no DAG mutation.
// visualGroups: array of group descriptors
// nodeToGroupId: Map<nodeId, groupId> for O(1) lookup
// edgeMap: same edge styling map as before

const { visualGroups, nodeToGroupId, edgeMap } = clusterNodes(data);

console.log(`Visual groups detected: ${visualGroups.length}`);
visualGroups.forEach(g => {
  console.log(`  ${g.id} (${g.reason}): [${g.memberIds.join(', ')}]`);
});

// Annotate each raw data node with its groupId (null if ungrouped).
// This makes groupId available later inside d.data during rendering.
data.forEach(node => {
  node.groupId = nodeToGroupId.get(node.id) ?? null;
});

// ------------------- //
// Phase 2: Layout DAG //
// ------------------- //
// Collapse visual groups to one Sugiyama node each (parentIds remapped to
// group ids). After layout, expand back to all courses for rendering.

const baseNodeRadius = 33;
const nodeW = baseNodeRadius * 3.1;
const nodeH = baseNodeRadius * 1.1;
const INTRA_GROUP_VERTICAL_GAP = 2;

const stratify = d3dag.graphStratify()
  .id(d => d.id)
  .parentIds(d => d.parentIds || []);

const layoutNodes = buildLayoutNodes(data, visualGroups, nodeToGroupId);

let layoutGraph;
try {
  layoutGraph = stratify(layoutNodes);
} catch (err) {
  console.error('Error building layout DAG:', err);
  throw err;
}

// -------------------- //
// Phase 3: Layout      //
// -------------------- //

// Roots reserve full stack height; leaves use one slot and expand into bottom margin.
const layoutNodeSize = createRoleAwareLayoutNodeSize(nodeW, nodeH, INTRA_GROUP_VERTICAL_GAP);
const shape = d3dag.tweakShape(layoutNodeSize, d3dag.shapeRect);
const LAYER_GAP_Y = nodeH * 0.55;
// With this — the path generator now accepts an optional trim:
function makePath(points, trimEnd = 0) {
  if (trimEnd === 0) return d3.line().curve(d3.curveMonotoneY)(points);
  const pts = [...points];
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const dx = last[0] - prev[0];
  const dy = last[1] - prev[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 0) {
    pts[pts.length - 1] = [
      last[0] - (dx / dist) * trimEnd,
      last[1] - (dy / dist) * trimEnd
    ];
  }
  return d3.line().curve(d3.curveMonotoneY)(pts);
}

const layout = d3dag
  .sugiyama()
  .layering(d3dag.layeringSimplex())
  .nodeSize(layoutNodeSize)
  .gap([baseNodeRadius, baseNodeRadius * 5.5])
  .tweaks([shape]);

layout(layoutGraph);

// ------------------------------ //
// Phase 4: Expand to course graph //
// ------------------------------ //

let graph;
try {
  graph = expandLayoutToCourseGraph(
    data,
    layoutGraph,
    visualGroups,
    nodeToGroupId,
    { nodeH, gap: INTRA_GROUP_VERTICAL_GAP },
  );
} catch (err) {
  console.error('Error building course DAG:', err);
  throw err;
}

const { width, height } = fitGraphToViewport(graph, nodeW, nodeH);

// ------------------------------ //
// Phase 4b: Deduplicate edges     //
// ------------------------------ //
// For grouped nodes, collapse redundant parallel edges into one
// representative visual edge per logical group connection.

function buildVisualLinks(graph, visualGroups, nodeToGroupId) {
  const nodeById = new Map();
  graph.nodes().forEach(n => nodeById.set(n.data.id, n));

  // For each group, find the top (min y) and bottom (max y) member node
  const groupTopNode = new Map();    // groupId -> node with smallest y
  const groupBottomNode = new Map(); // groupId -> node with largest y

  visualGroups.forEach(group => {
    const members = group.memberIds.map(id => nodeById.get(id)).filter(Boolean);
    members.sort((a, b) => a.y - b.y);
    groupTopNode.set(group.id, members[0]);
    groupBottomNode.set(group.id, members[members.length - 1]);
  });

  const visualLinks = [];
  // Track which logical connections have already been drawn
  // Key: "sourceNodeOrGroupId --> targetNodeOrGroupId"
  const seen = new Set();

  graph.links().forEach(link => {
    const srcId = link.source.data.id;
    const tgtId = link.target.data.id;
    const srcGroup = nodeToGroupId.get(srcId) ?? null;
    const tgtGroup = nodeToGroupId.get(tgtId) ?? null;

    // Logical endpoints (group id if grouped, node id if not)
    const logicalSrc = srcGroup ?? srcId;
    const logicalTgt = tgtGroup ?? tgtId;
    const key = `${logicalSrc}-->${logicalTgt}`;

    if (seen.has(key)) return; // already have a visual edge for this connection
    seen.add(key);

    // Resolve the actual node to draw from/to
    // Incoming to a group: draw to the top node of the group
    // Outgoing from a group: draw from the bottom node of the group
    const visualSource = srcGroup ? groupBottomNode.get(srcGroup) : link.source;
    const visualTarget = tgtGroup ? groupTopNode.get(tgtGroup)    : link.target;

    const points = [
      [visualSource.x, visualSource.y],
      [visualTarget.x, visualTarget.y]
    ];

    visualLinks.push({
      points,
      // Carry through the original source/target for edge style lookups
      source: link.source,
      target: link.target,
      logicalSrc,
      logicalTgt
    });
  });

  return visualLinks;
}

const visualLinks = buildVisualLinks(graph, visualGroups, nodeToGroupId);


// After moving nodes, patch the first and last waypoint of each link
// so edges connect to the updated node positions.
// (d3-dag computed link.points during layout, before we moved nodes.)
graph.links().forEach(link => {
  link.points[0] = [link.source.x, link.source.y];
  link.points[link.points.length - 1] = [link.target.x, link.target.y];
});

// ------------------- //
// Phase 5: Rendering  //
// ------------------- //

const svg = d3
  .select("#svg")
  .style("width", width + 4)
  .style("height", height + 50);

const trans = svg.transition().duration(500);

// Legend (unchanged)
const legend = svg.append("g")
  .attr("class", "legend")
  .attr("transform", `translate(20, 20)`);

const legendData = [
  { key: "Available", color: "steelblue", type: "box" },
  { key: "Taken", color: "#285841", type: "box" },
  { key: "Required Path", dash: "0", type: "line" },
  { key: "Optional Path", dash: "4,4", type: "line" }
];

legend.selectAll(".legend-item")
  .data(legendData)
  .join("g")
  .attr("class", "legend-item")
  .attr("transform", (d, i) => `translate(0, ${i * 20})`)
  .style("cursor", "default")
  .call(g => {
    g.each(function(d) {
      const group = d3.select(this);
      if (d.type === "box") {
        group.append("rect")
          .attr("x", -6).attr("y", -6)
          .attr("width", 12).attr("height", 12)
          .attr("fill", d.color)
          .attr("stroke", "white").attr("stroke-width", 1);
      } else {
        group.append("line")
          .attr("x1", -6).attr("x2", 6)
          .attr("y1", 0).attr("y2", 0)
          .attr("stroke", "black").attr("stroke-width", 2)
          .attr("stroke-dasharray", d.dash);
      }
      group.append("text")
        .attr("x", 12).attr("y", 0).attr("dy", "0.35em")
        .style("font-family", "sans-serif").style("font-size", "10px")
        .style("fill", "#333").text(d.key);
    });
  });

// --- Group bounding boxes ---
// Rendered before nodes so they sit behind everything.
// Build a nodeById map for bounding box coordinate lookups.
const nodeById = new Map();
graph.nodes().forEach(n => nodeById.set(n.data.id, n));

const GROUP_PADDING = 2;

svg.select("#groups")
  .selectAll("rect.visual-group")
  .data(visualGroups)
  .join("rect")
  .attr("class", "visual-group")
  .attr("rx", 12)
  .attr("fill", "none")
  .attr("stroke", "steelblue")
  .attr("stroke-width", 1.5)
  .attr("stroke-dasharray", "5,4")
  .attr("opacity", 0.45)
  .attr("x", group => {
    const xs = group.memberIds.map(id => nodeById.get(id)?.x ?? 0);
    return Math.min(...xs) - nodeW / 2 - GROUP_PADDING;
  })
  .attr("y", group => {
    const ys = group.memberIds.map(id => nodeById.get(id)?.y ?? 0);
    return Math.min(...ys) - nodeH / 2 - GROUP_PADDING;
  })
  .attr("width", group => {
    const xs = group.memberIds.map(id => nodeById.get(id)?.x ?? 0);
    return (Math.max(...xs) - Math.min(...xs)) + nodeW + GROUP_PADDING * 2;
  })
  .attr("height", group => {
    const ys = group.memberIds.map(id => nodeById.get(id)?.y ?? 0);
    return (Math.max(...ys) - Math.min(...ys)) + nodeH + GROUP_PADDING * 2;
  });

// --- Nodes ---
// Every node is an individual course. No cluster branching needed.

const Tooltip = d3.select("body").append("div")
  .attr("class", "tooltip")
  .style("position", "absolute")
  .style("padding", "6px 10px")
  .style("background", "#eaeded")
  .style("color", "black")
  .style("border-radius", "4px")
  .style("border-style", "solid")
  .style("font-size", "14px")
  .style("pointer-events", "none")
  .style("visibility", "hidden");

svg.select("#nodes")
  .selectAll("g")
  .data(graph.nodes())
  .join(enter =>
    enter.append("g")
      .attr("transform", ({ x, y }) => `translate(${x}, ${y})`)
      .attr("opacity", 0)
      .style("cursor", "pointer")
      .call(enter => {
        enter.each(function(d) {
          const g = d3.select(this);

          // Size the rect — wider for longer IDs
          let rectWidth = baseNodeRadius * 2.2;
          if (d.data.id.length > 7) rectWidth *= 1.4;
          const rectHeight = baseNodeRadius;

          g.append("rect")
            .attr("class", "course-rect")
            .attr("x", -rectWidth / 2)
            .attr("y", -rectHeight / 2)
            .attr("width", rectWidth)
            .attr("height", rectHeight)
            .attr("rx", 6)
            .attr("fill", "steelblue")
            .attr("stroke", "white")
            .attr("stroke-width", 2);

          g.append("text")
            .text(d.data.id)
            .attr("font-weight", "bold")
            .attr("font-family", "sans-serif")
            .attr("font-size", "12px")
            .attr("text-anchor", "middle")
            .attr("alignment-baseline", "middle")
            .attr("fill", "white")
            .style("pointer-events", "none");
        });

        enter.transition(trans).attr("opacity", 1);
      })
  );

// Tooltip events (attached once, outside the .each loop)
svg.select("#nodes").selectAll("g")
  .on("mouseover", (event, d) => {
    Tooltip
      .html(`<strong>${d.data.id}: ${d.data.name}</strong><br/>
             Prerequisites: ${d.data.PRQ?.join(' ') || 'None'}`)
      .style("top", (event.pageY + 10) + "px")
      .style("left", (event.pageX + 10) + "px")
      .style("visibility", "visible");
  })
  .on("mousemove", (event) => {
    Tooltip
      .style("top", (event.pageY + 10) + "px")
      .style("left", (event.pageX + 10) + "px")
  })
  .on("mouseout", () => {
    Tooltip.style("visibility", "hidden");
  });

// --- Links ---
svg.select("#links")
  .selectAll("path")
  .data(visualLinks)
  .join(enter =>
    enter.append("path")
      .attr("d", ({ points }) => makePath(points, 10))
      .attr("fill", "none")
      .attr("stroke-width", 3)
      .attr("stroke-dasharray", d => {
        const allEdgeInfo = edgeMap.get(d.source.data.id);
        if (allEdgeInfo) {
          const edgeInfo = allEdgeInfo.find(e => e.target === d.target.data.id);
          if (edgeInfo && edgeInfo.style === "dashed") return '5px';
        }
        return '50%';
      })
      .attr("stroke", "black")
      .attr("opacity", 0)
      .call(enter => enter.transition(trans).attr("opacity", 0.7))
  );

// --- Arrows ---
function arrowTransform(linkData) {
  const points = linkData.points;
  const [x1, y1] = points[points.length - 2];
  const [x2, y2] = points[points.length - 1];
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 90;
  return `translate(${x2}, ${y2}) rotate(${angle})`;
}

const arrowSize = 80;
const arrowLen = Math.sqrt((4 * arrowSize) / Math.sqrt(3));
const arrow = d3.symbol().type(d3.symbolTriangle).size(arrowSize);

svg.select("#arrows")
  .selectAll("path")
  .data(visualLinks)
  .join(enter =>
    enter.append("path")
      .attr("d", arrow)
      .attr("fill", "black")
      .attr("transform", arrowTransform)
      .attr("opacity", 0.7)
      .attr("stroke", "white")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", `${arrowLen},${arrowLen}`)
      .call(enter => enter.transition(trans).attr("opacity", 1))
  );

// ----------------------- //
// Sidebar: populate lists //
// ----------------------- //

function populateSidebar(data) {
  const sorted = [...data].sort((a, b) => a.id.localeCompare(b.id));

  sorted.forEach(course => {
    const container = document.getElementById(`list-${course.group}`);
    if (!container) {
      console.warn(`No sidebar list for group "${course.group}" (${course.id})`);
      return;
    }

    const label = document.createElement('label');
    label.className = 'course-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.courseId = course.id;
    checkbox.dataset.group = course.group;
    checkbox.onchange = function() {
      colorClass(this);
      updateGroupCheckbox(course.group);
    };

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${course.id}: ${course.name}`));
    container.appendChild(label);
  });

  if (typeof initAllProgressIndicators === 'function') {
    initAllProgressIndicators();
  }
}

populateSidebar(data);


