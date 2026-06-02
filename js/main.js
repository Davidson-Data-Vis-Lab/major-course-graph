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
  // return d3.line().curve(d3.curveBumpY)(pts); // [EXPERIMENT ORGANIZE]
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
    { nodeW, nodeH, gap: INTRA_GROUP_VERTICAL_GAP },
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

  const groupTopNode = new Map();    
  const groupBottomNode = new Map(); 

  visualGroups.forEach(group => {
    const members = group.memberIds.map(id => nodeById.get(id)).filter(Boolean);
    members.sort((a, b) => a.y - b.y);
    groupTopNode.set(group.id, members[0]);
    groupBottomNode.set(group.id, members[members.length - 1]);
  });

  // Create a quick lookup map of the layout graph links that actually contain the computed curves!
  const layoutPointsMap = new Map();
  layoutGraph.links().forEach(link => {
    const key = `${link.source.data.id}-->${link.target.data.id}`;
    if (link.points) {
      layoutPointsMap.set(key, link.points);
    }
  });

  const incomingLinksMap = new Map();

  graph.links().forEach(link => {
    const srcId = link.source.data.id;
    const tgtId = link.target.data.id;
    const srcGroup = nodeToGroupId.get(srcId) ?? null;
    const tgtGroup = nodeToGroupId.get(tgtId) ?? null;

    const logicalSrc = srcGroup ?? srcId;
    const logicalTgt = tgtGroup ?? tgtId;
    const key = `${logicalSrc}-->${logicalTgt}`;

    const visualTarget = tgtGroup ? groupTopNode.get(tgtGroup) : link.target;
    const visualSource = srcGroup ? groupBottomNode.get(srcGroup) : link.source;
    const vtId = visualTarget.data.id;

    if (!incomingLinksMap.has(vtId)) {
      incomingLinksMap.set(vtId, []);
    }
    
    const list = incomingLinksMap.get(vtId);
    if (!list.some(item => item.key === key)) {
      list.push({
        link,
        key,
        sourceX: visualSource.x,
        visualSource,
        visualTarget,
        logicalSrc,
        logicalTgt
      });
    }
  });

  const visualLinks = [];

  incomingLinksMap.forEach((incomingList, vtId) => {
    incomingList.sort((a, b) => a.sourceX - b.sourceX);

    const count = incomingList.length;
    const visualTarget = incomingList[0].visualTarget;

    let rectWidth = baseNodeRadius * 2.2;
    if (visualTarget.data.id.length > 7) rectWidth *= 1.4;
    const usableWidth = rectWidth * 0.7; 

    incomingList.forEach((item, index) => {
      const { visualSource, logicalSrc, logicalTgt } = item;
      
      // Look up the beautiful curved layout points from the original math layout graph!
      const layoutKey = `${logicalSrc}-->${logicalTgt}`;
      const originalPoints = layoutPointsMap.get(layoutKey);
      
      let points = [];
      if (originalPoints && originalPoints.length > 1) {
        // Deep copy the internal path routing waypoints calculated by Sugiyama
        points = originalPoints.map(p => [...p]);
      } else {
        // Fallback safety straight line if no routing points exist
        points = [[visualSource.x, visualSource.y], [visualTarget.x, visualTarget.y]];
      }

      let xOffset = 0;
      if (count > 1) {
        xOffset = ((index / (count - 1)) - 0.5) * usableWidth;
      }

      const halfH = baseNodeRadius / 2;
      const gapBuffer = 6; 

      // Snap the first point directly to the bottom edge of the source card
      points[0] = [visualSource.x, visualSource.y + halfH];
      
      // Snap the last point to our beautifully calculated staggered slot above the target card
      points[points.length - 1] = [visualTarget.x + xOffset, visualTarget.y - halfH - gapBuffer];

      visualLinks.push({
        points,
        source: item.link.source,
        target: item.link.target,
        logicalSrc,
        logicalTgt
      });
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
  { key: "Unavailable", color: "#aaaaaa", type: "box" },
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
            .attr("font-size", "12px")
            .attr("text-anchor", "middle")
            .attr("alignment-baseline", "middle")
            .attr("fill", "white")
            .style("pointer-events", "none");
        });

        enter.transition(trans).attr("opacity", 1);
      })
  );

// Interaction events
svg.select("#nodes").selectAll("g")
  // tooltip
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
  })
  // click for taken courses
  .on("click", (event, d) => {
    const checkbox = document.querySelector(
      `input[data-course-id="${d.data.id}"]`
    );

    if (!checkbox) return;

    checkbox.checked = !checkbox.checked;

    if (typeof checkbox.onchange === "function") {
      checkbox.onchange();
    }
  });

// --- Links ---
svg.select("#links")
  .selectAll("path")
  .data(visualLinks)
  .join(enter =>
    enter.append("path")
      .attr("d", ({ points }) => makePath(points, 2))
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
  

  // Sort courses within each group alphabetically by id
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
      recomputeAllNodeColors(this);
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

// --------------------------------- //
// Phase 6: Three-state node coloring //
// --------------------------------- //

const NODE_COLOR = {
  taken:       "#285841",  // green
  available:   "steelblue", // blue
  unavailable: "#aaaaaa",  // gray
};

/**
 * Recursively evaluate a PRQ token array against a set of taken course IDs.
 * Returns true if the prerequisite expression is satisfied.
 *
 * Token array format: each entry is either a full course ID string,
 * or one of: "and", "or", "(", ")"
 *
 * Top-level: implicit AND between all non-OR-separated terms.
 * "or" between terms means either satisfies.
 * Parentheses group sub-expressions.
 */
function evaluatePrerequisites(tokens, takenSet) {
  if (!tokens || tokens.length === 0) return true; // no prereqs = always available

  // Find the matching closing paren for an opening paren at index i
  function matchParen(toks, i) {
    let depth = 0;
    for (let j = i; j < toks.length; j++) {
      if (toks[j] === '(') depth++;
      else if (toks[j] === ')') { depth--; if (depth === 0) return j; }
    }
    return toks.length - 1;
  }

  // Split tokens into clauses separated by the given operator at the top level
  function splitBy(toks, op) {
    const clauses = [];
    let current = [];
    let depth = 0;
    for (const t of toks) {
      if (t === '(') { depth++; current.push(t); }
      else if (t === ')') { depth--; current.push(t); }
      else if (t === op && depth === 0) {
        clauses.push(current);
        current = [];
      } else {
        current.push(t);
      }
    }
    if (current.length > 0) clauses.push(current);
    return clauses;
  }

  function evaluate(toks) {
    if (toks.length === 0) return true;

    // Strip outer parens
    if (toks[0] === '(' && matchParen(toks, 0) === toks.length - 1) {
      return evaluate(toks.slice(1, toks.length - 1));
    }

    // OR has lower precedence — split by 'or' first
    const orClauses = splitBy(toks, 'or');
    if (orClauses.length > 1) {
      return orClauses.some(clause => evaluate(clause));
    }

    // AND — split by 'and'
    const andClauses = splitBy(toks, 'and');
    if (andClauses.length > 1) {
      return andClauses.every(clause => evaluate(clause));
    }

    // Single token — must be a course ID
    const courseId = toks.join(' ').trim(); // handles multi-word IDs defensively
    return takenSet.has(courseId);
  }

  return evaluate(tokens);
}

/**
 * Build a Set of course IDs the user has marked as taken,
 * by reading all checked course checkboxes in the sidebar.
 */
function getTakenSet() {
  const taken = new Set();
  document.querySelectorAll('input[type="checkbox"][data-course-id]').forEach(cb => {
    if (cb.checked) taken.add(cb.dataset.courseId);
  });
  return taken;
}

/**
 * Recompute and apply green/blue/gray to every node in the graph.
 * Called whenever the taken-course set changes.
 */
/**
 * Recompute and apply green/blue/gray to every node in the graph.
 * Handles the initial all-blue state and updates arrow/link colors dynamically.
 */
function recomputeAllNodeColors() {
  const takenSet = getTakenSet();
  const isInitialState = (takenSet.size === 0);
  
  // Keep track of evaluated individual node states
  const nodeStates = new Map();

  // 1. Process and update Node Colors
  d3.selectAll("#nodes > g").each(function(d) {
    const courseId = d.data.id;
    const prq = d.data.PRQ ?? [];

    let state;
    if (takenSet.has(courseId)) {
      state = "taken";
    } else if (evaluatePrerequisites(prq, takenSet)) {
      state = "available";
    } else {
      state = "unavailable";
    }
    
    nodeStates.set(courseId, state);

    // Initial state override: Force everything to show up blue
    const finalColor = isInitialState ? NODE_COLOR.available : NODE_COLOR[state];
    d3.select(this).select("rect.course-rect").attr("fill", finalColor);
  });

  // Create a fast group lookup map: groupId -> array of member course IDs
  const groupMembersMap = new Map();
  visualGroups.forEach(g => {
    groupMembersMap.set(g.id, g.memberIds);
  });

  // 2. Compute dynamic line and arrow colors
  function getLinkColor(d) {
    // Check initial state condition first
    if (isInitialState) {
      return "black";
    }

    const srcId = d.source.data.id;
    const tgtId = d.target.data.id;

    // Determine the source group if it exists
    const srcGroupId = nodeToGroupId.get(srcId);
    
    // Gather all source course IDs we care about. 
    // If it's in a group, look at all group members. If singleton, just look at itself.
    const sourceCoursesToCheck = srcGroupId ? (groupMembersMap.get(srcGroupId) ?? [srcId]) : [srcId];

    // Determine the target group if it exists
    const tgtGroupId = nodeToGroupId.get(tgtId);
    const targetCoursesToCheck = tgtGroupId ? (groupMembersMap.get(tgtGroupId) ?? [tgtId]) : [tgtId];

    // Check if ANY target node in the connected layout slot is available or taken
    const isTargetAccessible = targetCoursesToCheck.some(id => {
      const state = nodeStates.get(id);
      return state === "taken" || state === "available";
    });
    // Check if ANY source node in the connected layout slot has been taken
    const isAnySourceTaken = sourceCoursesToCheck.some(id => takenSet.has(id));

    return (isAnySourceTaken && isTargetAccessible) ? "black" : "#e2e8f0"
  }

  // Apply colors to edge paths
  d3.select("#links").selectAll("path")
    .attr("stroke", getLinkColor)
    .attr("opacity", d => getLinkColor(d) === "black" ? 0.9 : 0.35); // Pop active paths!

  // Apply colors to structural triangle pointer markers
  d3.select("#arrows").selectAll("path")
    .attr("fill", getLinkColor);
}

// Expose so index.html script block can call it
window.recomputeAllNodeColors = recomputeAllNodeColors;

// Run once on load so unavailable courses start gray
recomputeAllNodeColors();
