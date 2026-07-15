console.log("main.js is running...");
/**
 * Based on Erik Brinkman's https://codepen.io/brinkbot/pen/oNQwNRv
 * 
 * 
 */

import * as d3 from "https://cdn.skypack.dev/d3@7.8.4";
import * as d3dag from "https://cdn.skypack.dev/d3-dag@1.0.0-1";
import { clusterNodes } from './clusterNodes.js';
import {
  buildLayoutNodes,
  createRoleAwareLayoutNodeSize,
  expandLayoutToCourseGraph,
  fitGraphToViewport,
} from './groupLayout.js';

//const data = await d3.json("computer-science-data/courses-handcollected-with-note-strings.json");
const data = await d3.json("chemistry-data/courses_handcollected_chemistry.json");


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

const screenWidth = window.innerWidth;
const screenHeight = window.innerHeight;
const nodeRatio = 18/1512; // ratio of node radius to screen width that will size each node accordingly
const fontRatio = 7/18; // ratio of font size to node radius for scaling text with node size

const baseNodeRadius = screenWidth * nodeRatio;
const nodeW = baseNodeRadius * 2.2;
const nodeH = baseNodeRadius;
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
  .gap([baseNodeRadius * 2, baseNodeRadius * 4])
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
  // Create a quick lookup map of the layout graph links that contain the computed curves
  const layoutPointsMap = new Map();
  if (typeof layoutGraph !== 'undefined' && layoutGraph.links) {
    layoutGraph.links().forEach(link => {
      const key = `${link.source.data.id}-->${link.target.data.id}`;
      if (link.points) {
        layoutPointsMap.set(key, link.points);
      }
    });
  }

  const incomingLinksMap = new Map();

  graph.links().forEach(link => {
    const srcId = link.source.data.id;
    const tgtId = link.target.data.id;
    const srcGroup = nodeToGroupId.get(srcId) ?? null;
    const tgtGroup = nodeToGroupId.get(tgtId) ?? null;

    // The logical link key maps group-to-group, group-to-node, or node-to-node
    const logicalSrc = srcGroup ?? srcId;
    const logicalTgt = tgtGroup ?? tgtId;
    const key = `${logicalSrc}-->${logicalTgt}`;

    // Anchor tracking is bound directly to the base target ID now
    const vtId = link.target.data.id;

    if (!incomingLinksMap.has(vtId)) {
      incomingLinksMap.set(vtId, []);
    }
    
    const list = incomingLinksMap.get(vtId);
    if (!list.some(item => item.key === key)) {
      list.push({
        link,
        key,
        sourceX: link.source.x,
        logicalSrc,
        logicalTgt,
        srcGroup,
        tgtGroup
      });
    }
  });

  const visualLinks = [];

  incomingLinksMap.forEach((incomingList, vtId) => {
    // Sort incoming streams left-to-right based on their source positions
    incomingList.sort((a, b) => a.sourceX - b.sourceX);

    const count = incomingList.length;
    const firstItem = incomingList[0];
    const visualTarget = firstItem.link.target;

    // Establish width profiles for calculating the slot distributions
    let rectWidth = baseNodeRadius * 2.2;
    if (visualTarget.data.id.length > 7) rectWidth *= 1.4;
    const usableWidth = rectWidth * 0.7; 

    incomingList.forEach((item, index) => {
      const { link, logicalSrc, logicalTgt, srcGroup, tgtGroup } = item;
      
      const layoutKey = `${logicalSrc}-->${logicalTgt}`;
      const originalPoints = layoutPointsMap.get(layoutKey);
      
      let points = [];
      if (originalPoints && originalPoints.length > 1) {
        points = originalPoints.map(p => [...p]);
      } else {
        points = [[link.source.x, link.source.y], [link.target.x, link.target.y]];
      }

      // Calculate the point distribution offset across the face of the targets
      let xOffset = 0;
      if (count > 1) {
        xOffset = ((index / (count - 1)) - 0.5) * usableWidth;
      }

      const halfH = baseNodeRadius / 2;
      
      // Default fallback anchors (Singletons use these coordinates directly,
      // while cluster links use them as temporary placeholders until Phase 5 snaps them)
      points[0] = [link.source.x, link.source.y + halfH];
      points[points.length - 1] = [link.target.x + xOffset, link.target.y - halfH];

      visualLinks.push({
        points,
        source: link.source,
        target: link.target,
        logicalSrc,
        logicalTgt,
        srcGroup, 
        tgtGroup,
        xOffset   
      });
    });
  });

  return visualLinks;
}

const visualLinks = buildVisualLinks(graph, visualGroups, nodeToGroupId);



// ------------------- //
// Phase 5: Rendering  //
// ------------------- //

const svg = d3
  .select("#svg")
  .style("width", width + 4)
  .style("height", height + 50);

// --- Zoom ---
const zoom = d3.zoom()
  .scaleExtent([0.75, 3])         // min 75% zoom, max 300%
  .translateExtent([[-100, -100], [width + 100, height + 100]])
  .on("zoom", (event) => {
    svg.select("g").attr("transform", event.transform);
  });

svg.call(zoom);

// reset zoom function
// // double click
// svg.on("dblclick.zoom", () => svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity));
// vs button
const foreignObject = svg.append("foreignObject")
  .attr("x", 25)
  .attr("y", 135)
  .attr("width", 137)
  .attr("height", 36);

foreignObject.append("xhtml:button")
  .attr("class", "btn")
  .style("width", "100%")
  .text("Reset Zoom")
  .on("click", () => {
    svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
  });

const trans = svg.transition().duration(500);

// --- Search Interface HTML Injection ---
// Placed near the top left corner (10px down, 150px right of your viewport edge wrapper)
const searchWrapper = d3.select("body")
  .append("div")
  .attr("class", "search-container")
  .style("left", "650px") // Positioned safely off the side panel boundaries
  .style("top", "25px");

searchWrapper.html(`
  <input type="text" class="search-input" placeholder="Search Course ID or Name..." autocomplete="off">
  <ul class="search-dropdown" style="display: none;"></ul>
`);

const searchInput = searchWrapper.select(".search-input");
const searchDropdown = searchWrapper.select(".search-dropdown");

// Legend
// const legend = svg.append("g")
//   .attr("class", "legend")
//   .attr("transform", `translate(20, 20)`);

// const legendData = [
//   { key: "Unavailable", color: "#aaaaaa", type: "box" },
//   { key: "Available", color: "steelblue", type: "box" },
//   { key: "Taken", color: "#285841", type: "box" },
//   { key: "Required Path", dash: "0", type: "line" },
//   { key: "Optional Path", dash: "4,4", type: "line" }
// ];

// legend.selectAll(".legend-item")
//   .data(legendData)
//   .join("g")
//   .attr("class", "legend-item")
//   .attr("transform", (d, i) => `translate(0, ${i * 20})`)
//   .style("cursor", "default")
//   .call(g => {
//     g.each(function(d) {
//       const group = d3.select(this);
//       if (d.type === "box") {
//         group.append("rect")
//           .attr("x", -6).attr("y", -6)
//           .attr("width", 12).attr("height", 12)
//           .attr("fill", d.color)
//           .attr("stroke", "white").attr("stroke-width", 1);
//       } else {
//         group.append("line")
//           .attr("x1", -6).attr("x2", 6)
//           .attr("y1", 0).attr("y2", 0)
//           .attr("stroke", "black").attr("stroke-width", 2)
//           .attr("stroke-dasharray", d.dash);
//       }
//       group.append("text")
//         .attr("x", 12).attr("y", 0).attr("dy", "0.35em")
//         .style("fill", "#333").text(d.key);
//     });
//   });

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
  // Give it an identifier so we can query its coordinates in real-time
  .attr("data-group-id", group => group.id) 
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

  // ==================================================
// DYNAMIC REAL-TIME GEOMETRY ADJUSTMENT
// ==================================================
// Now that the cluster bounding boxes exist live in the DOM, 
// we query their real coordinates and snap the lines to them.
visualLinks.forEach(link => {
  // 1. Adjust Origin Point (If coming FROM a cluster box)
  if (link.srcGroup) {
    const boxEl = document.querySelector(`rect[data-group-id="${link.srcGroup}"]`);
    if (boxEl) {
      const bx = parseFloat(boxEl.getAttribute("x"));
      const by = parseFloat(boxEl.getAttribute("y"));
      const bw = parseFloat(boxEl.getAttribute("width"));
      const bh = parseFloat(boxEl.getAttribute("height"));
      
      // Start perfectly from the exact horizontal center of the bottom border edge
      link.points[0] = [bx + bw / 2, by + bh];
    }
  }

  // 2. Adjust Destination Point (If pointing TO a cluster box)
  if (link.tgtGroup) {
    const boxEl = document.querySelector(`rect[data-group-id="${link.tgtGroup}"]`);
    if (boxEl) {
      const bx = parseFloat(boxEl.getAttribute("x"));
      const by = parseFloat(boxEl.getAttribute("y"));
      const bw = parseFloat(boxEl.getAttribute("width"));
      
      const gapBuffer = 6; 
      
      // Target points spread evenly along the absolute top boundary edge of the box container
      const targetX = bx + bw / 2 + link.xOffset;
      const targetY = by - gapBuffer;
      
      link.points[link.points.length - 1] = [targetX, targetY];
    }
  }
  
  // Clean up routing artifacts to keep vectors looking smooth
  if (link.points.length > 2) {
    const startY = link.points[0][1];
    const endY = link.points[link.points.length - 1][1];
    link.points = link.points.filter(p => p[1] <= endY && p[1] >= startY);
    link.points.unshift([link.points[0][0], link.points[0][1]]);
    link.points.push([link.points[link.points.length-1][0], link.points[link.points.length-1][1]]);
  }
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

function repositionTooltip(cursorX, cursorY) {
  const tipW = Tooltip.node().offsetWidth;
  const tipH = Tooltip.node().offsetHeight;
  const pad = 8;
  const gap = 12;

  const spaceOnRight = window.innerWidth  - cursorX - gap;
  const spaceBelow   = window.innerHeight - cursorY - gap;

  const finalX = spaceOnRight >= tipW
    ? cursorX + gap
    : cursorX - tipW - gap;

  const finalY = spaceBelow >= tipH
    ? cursorY + gap
    : cursorY - tipH - gap;

  Tooltip
    .style("left", Math.max(pad, finalX) + "px")
    .style("top",  Math.max(pad, finalY) + "px");
}

function shortDesc(text, wordLimit = 20) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= wordLimit) return 'Description: ' + text;
  return 'Description: ' + words.slice(0, wordLimit).join(' ') + '...(double-click for full description)';
}

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

          const label = d.data.id;
          const textEl = g.append("text")
            .attr("font-weight", "bold")
            .attr("font-size", `${baseNodeRadius * fontRatio}px`)
            .attr("text-anchor", "middle")
            .attr("alignment-baseline", "middle")
            .attr("fill", "white")
            .style("pointer-events", "none");

          const creditForPrefix = "Credit for ";
          let line1;
          let line2;
          if (label.startsWith(creditForPrefix) && label.length > creditForPrefix.length) {
            line1 = "Credit for";
            line2 = label.slice(creditForPrefix.length);
          } else if (label.length > 14) {
            line1 = label.slice(0, 14);
            line2 = label.slice(14);
          }

          if (line2) {
            textEl.append("tspan")
              .attr("x", 0)
              .attr("dy", "-0.15em")
              .text(line1);
            textEl.append("tspan")
              .attr("x", 0)
              .attr("dy", "0.9em")
              .text(line2);
          } else {
            textEl.text(label);
          }
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
             Prerequisites: ${d.data.PRQ?.join(' ') || 'None'}<br/>
             Description: ${d.data.description.slice(0, 120) || ''}`) // Truncate description for tooltip
      .style("top", (event.pageY + 10) + "px")
      .style("left", (event.pageX + 10) + "px")
      .style("visibility", "visible");

    const naturalWidth = Tooltip.node().offsetWidth;

    // Now set the measured width as the cap and add the description
    Tooltip
      .style("max-width", naturalWidth + "px")
      .html(
        `<strong>${d.data.id}: ${d.data.name}</strong><br/>`
        + `Prerequisites: ${d.data.PRQ?.join(' ') || 'None'}`
        + (d.data.description ? `<br/><br/>${shortDesc(d.data.description)}` : '')
      )
      .style("visibility", "visible");
      repositionTooltip(event.clientX, event.clientY);
  })
  .on("mousemove", (event) => {
    repositionTooltip(event.clientX, event.clientY);
  })
  .on("mouseout", () => {
    Tooltip.style("visibility", "hidden");
  })
  .on("dblclick", (event, d) => {
    
    Tooltip
      .style("max-width", "none") 
      .html(`<strong>${d.data.id}: ${d.data.name}</strong><br/>`
             + `Prerequisites: ${d.data.PRQ?.join(' ') || 'None'}`)
      .style("visibility", "visible");

    const naturalWidth = Tooltip.node().offsetWidth;

    // Now set the measured width as the cap and add the description
    Tooltip
      .style("max-width", naturalWidth + "px")
      .html(
        `<strong>${d.data.id}: ${d.data.name}</strong><br/>`
        + `Prerequisites: ${d.data.PRQ?.join(' ') || 'None'}`
        + (d.data.description ? `<br/><br/>${d.data.description}` : '')
      )
      .style("visibility", "visible");
      repositionTooltip(event.clientX, event.clientY);
  })
    // click for taken courses
  .on("click", (event, d) => {
    const checkbox = document.querySelector(
      `input[data-course-id="${d.data.id}"]`
    );

    if (!checkbox) return;

    tryMarkCourseTaken(d.data.id, !checkbox.checked, 'node');
  });

// --- Links ---
svg.select("#links")
  .selectAll("path")
  .data(visualLinks)
  .join(enter =>
    enter.append("path")
    .attr("d", d => {
      // If pointing to a clustered box, our gapBuffer (6) already handles spacing,
      // so we pass 0 to let it draw fully to its calculated border slot.
      if (d.tgtGroup) {
        return makePath(d.points, 0); 
      }
      
      // For individual nodes
      return makePath(d.points, 7);
    })
      .attr("fill", "none")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", d => {
        const srcId = d.source.data.id;
        const tgtId = d.target.data.id;
        const srcGroupId = nodeToGroupId.get(srcId);

        if (srcGroupId) {
          const group = visualGroups.find(g => g.id === srcGroupId);
          if (group) {
            const memberEdges = group.memberIds.map(mId => {
              const allEdgeInfo = edgeMap.get(mId);
              return allEdgeInfo ? allEdgeInfo.find(e => e.target === tgtId) : null;
            }).filter(Boolean);

            if (memberEdges.length > 0 && memberEdges.every(e => e.style === "dashed")) {
              return "none"; 
            }
          }
        }

        const allEdgeInfo = edgeMap.get(srcId);
        if (allEdgeInfo) {
          const edgeInfo = allEdgeInfo.find(e => e.target === tgtId);
          if (edgeInfo && edgeInfo.style === "dashed") return '5px';
        }
        return "none";
      })
      .attr("stroke", "black")
      .attr("opacity", 0)
      .call(enter => enter.transition(trans).attr("opacity", 0.7))
  );



const arrowSize = 80;
const arrow = d3.symbol().type(d3.symbolTriangle).size(arrowSize);

// // Clean up any old arrow tracking paths first
// svg.select("#arrows").selectAll("path").remove();

// Bind your link dataset to build the arrowheads
svg.select("#arrows")
  .selectAll("path")
  .data(visualLinks)
  .join("path")
    .attr("d", arrow)
    .attr("fill", "black")
    .attr("opacity", 0.7)
    .attr("stroke", "white")
    .attr("stroke-width", 1.5)
    .each(function(d, i) {
      // 1. Find the corresponding rendered line path inside the DOM
      // We look up the exact index matching the current link element
      const pathNodes = svg.select("#links").selectAll("path").nodes();
      const correspondingPath = pathNodes[i];

      if (!correspondingPath) return;

      // 2. Query the real browser SVG measurements
      const totalLength = correspondingPath.getTotalLength();
      
      // Step backward by 0.5 pixels to get an ultra-precise local direction vector
      const p2 = correspondingPath.getPointAtLength(totalLength);
      const p1 = correspondingPath.getPointAtLength(Math.max(0, totalLength - 0.5));

      // 3. Compute the exact local tangent angle of the curve
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      
      // Fallback to purely vertical downward if the vector math returns 0
      let angle = 0; 
      if (dx !== 0 || dy !== 0) {
        angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      }

      // 4. Snap the arrow position and rotation seamlessly to the line tip
      d3.select(this)
        .attr("transform", `translate(${p2.x}, ${p2.y}) rotate(${angle})`);
    })
    .call(enter => enter.transition(trans).attr("opacity", 1));

// ----------------------- //
// Sidebar: populate lists //
// ----------------------- //

function populateSidebar(data) {
  

  // Sort courses within each group alphabetically by id
  const sorted = [...data].sort((a, b) => a.id.localeCompare(b.id));

  sorted.forEach(course => {
    const container = document.getElementById(`list-${course.group}`);
    if (!container) {
      //console.warn(`No sidebar list for group "${course.group}" (${course.id})`);
      return;
    }

    const label = document.createElement('label');
    label.className = 'course-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.courseId = course.id;
    checkbox.dataset.group = course.group;
    checkbox.onchange = function() {
      tryMarkCourseTaken(course.id, this.checked, 'sidebar');
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
  taken:       "#d16b05",  // orange
  available:   "#20a23a", // green
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
    if (toks.length === 1) {
      const courseId = toks[0].trim();
      return takenSet.has(courseId);
    }
    const courseId = toks.join(' ').trim(); // handles multi-word IDs defensively
    return takenSet.has(courseId);
  }

  return evaluate(tokens);
}

/**
 * Returns an array of human-readable strings describing which
 * top-level prerequisite clauses are still unmet.
 * Preserves OR-group structure rather than expanding to individual courses.
 */
function getMissingPrereqs(tokens, takenSet) {
  if (!tokens || tokens.length === 0) return [];

  function matchParen(toks, i) {
    let depth = 0;
    for (let j = i; j < toks.length; j++) {
      if (toks[j] === '(') depth++;
      else if (toks[j] === ')') { depth--; if (depth === 0) return j; }
    }
    return toks.length - 1;
  }

  function splitByTopLevelAnd(toks) {
    const clauses = [];
    let current = [];
    let depth = 0;
    for (const t of toks) {
      if (t === '(') { depth++; current.push(t); }
      else if (t === ')') { depth--; current.push(t); }
      else if (t === 'and' && depth === 0) {
        if (current.length) clauses.push(current);
        current = [];
      } else {
        current.push(t);
      }
    }
    if (current.length) clauses.push(current);
    return clauses;
  }

  function clauseIsMet(clause) {
    // Strip outer parens for evaluation
    let toks = clause;
    while (toks[0] === '(' && matchParen(toks, 0) === toks.length - 1) {
      toks = toks.slice(1, toks.length - 1);
    }
    // OR clause — any one satisfied
    if (toks.includes('or')) {
      return toks
        .filter(t => t !== 'or' && t !== '(' && t !== ')')
        .some(t => takenSet.has(t));
    }
    // AND clause or single course
    return toks
      .filter(t => t !== 'and' && t !== '(' && t !== ')')
      .every(t => takenSet.has(t));
  }

  function clauseToString(clause) {
    // Single course
    if (clause.length === 1) return clause[0];
    // Already wrapped in parens — preserve as-is
    if (clause[0] === '(' && matchParen(clause, 0) === clause.length - 1) {
      return clause.join(' ');
    }
    return clause.join(' ');
  }

  const topLevelClauses = splitByTopLevelAnd(tokens);
  return topLevelClauses
    .filter(clause => !clauseIsMet(clause))
    .map(clauseToString);
}

/**
 * Extracts all individual course IDs from a missing prereq clause string.
 * e.g. "(MAT 140 or MAT 150)" → ["MAT 140", "MAT 150"]
 * e.g. "CSC 221" → ["CSC 221"]
 */
function extractCourseIdsFromClause(clauseStr) {
  return clauseStr
    .replace(/[()]/g, '')
    .split(/\s+(?:or|and)\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function tryMarkCourseTaken(courseId, desiredChecked, source = 'node') {
  const checkbox = document.querySelector(
    `input[data-course-id="${CSS.escape(courseId)}"]`
  );
  if (!checkbox) return;

  // Unchecking is always allowed
  if (!desiredChecked) {
    checkbox.checked = false;
    recomputeAllNodeColors();
    updateGroupCheckbox(checkbox.dataset.group);
    return;
  }

  const courseData = data.find(d => d.id === courseId);
  const prq = courseData?.PRQ ?? [];
  const takenSet = getTakenSet();

  if (evaluatePrerequisites(prq, takenSet)) {
    // prereqs met — commit
    checkbox.checked = true;
    recomputeAllNodeColors();
    updateGroupCheckbox(checkbox.dataset.group);
    return;
  }

  // prereqs NOT met — revert checkbox immediately
  checkbox.checked = false;

  const missing = getMissingPrereqs(prq, takenSet);
  const missingHtml = missing.length
    ? `<br/><br/><span style="color:#c0392b;font-weight:600">✕ Missing prerequisites:</span>`
      + missing.map(m => `<br/>• ${m}`).join('')
    : `<br/><br/><span style="color:#c0392b">✕ Prerequisites not met</span>`;

  // Find the node element
  let targetNode = null;
  svg.select("#nodes").selectAll("g").each(function(d) {
    if (d.data.id === courseId) targetNode = this;
  });

  if (targetNode) {
    // Flash red border regardless of source
    const rect = d3.select(targetNode).select("rect.course-rect");
    rect.attr("stroke", "#c0392b").attr("stroke-width", 4);
    setTimeout(() => rect.attr("stroke", "white").attr("stroke-width", 2), 1000);

    if (source === 'node') {
      // Node click: just update the existing hover tooltip in place.
      // It's already visible because the user is hovering over the node.
      Tooltip
        .style("max-width", "none") // cap max width for better readability of long descriptions
        .html(
          `<strong>${courseData.id}: ${courseData.name}</strong>`
          + `<br/>Prerequisites: ${prq?.join(' ') || 'None'}`
        );

      const naturalWidth = Tooltip.node().offsetWidth;

      Tooltip
        .style("max-width", naturalWidth + "px")
        .html(
          `<strong>${courseData.id}: ${courseData.name}</strong><br/>`
          + `Prerequisites: ${prq?.join(' ') || 'None'}`
          + (courseData.description ? `<br/><br/>${shortDesc(courseData.description)}` : '')
          + missingHtml
        );

      // Tooltip position is already correct from the mouseover handler — no move needed.

    } else {
      // Sidebar click: user is not hovering, so we spawn and auto-dismiss the tooltip.
      const svgEl = document.getElementById("svg");
      const svgRect = svgEl.getBoundingClientRect();
      const nodeData = d3.select(targetNode).datum();

      const transform = d3.zoomTransform(svgEl);
      const nodeScreenX = transform.applyX(nodeData.x) + svgRect.left;
      const nodeScreenY = transform.applyY(nodeData.y) + svgRect.top - 10;

      // Render tooltip offscreen first so we can measure its dimensions
      Tooltip
        .style("max-width", "none") 
        .html(
          `<strong>${courseData.id}: ${courseData.name}</strong>`
          + `<br/>Prerequisites: ${prq?.join(' ') || 'None'}`
        )
        .style("visibility", "hidden")  // hidden but in-flow so it has dimensions
        .style("left", "0px")
        .style("top",  "0px");

      const naturalWidth = Tooltip.node().offsetWidth;

      // Now read its rendered size
      const tipW = Tooltip.node().offsetWidth;
      const tipH = Tooltip.node().offsetHeight;
      const pad  = 8; // minimum gap from viewport edge
      const gap = 20; // distance from node edge to tooltip edge

      // Flip to left side if not enough room on the right
      const spaceOnRight = window.innerWidth - nodeScreenX - gap;
      const finalX = spaceOnRight >= tipW
        ? nodeScreenX + gap                  // enough room — place right
        : nodeScreenX - tipW - gap;          // not enough room — flip left

      // Flip upward if not enough room below
      const spaceBelow = window.innerHeight - nodeScreenY - gap;
      const finalY = spaceBelow >= tipH
        ? nodeScreenY + gap                  // enough room — place below
        : nodeScreenY - tipH - gap;          // not enough room — flip above

      Tooltip
        .style("left", Math.max(pad, finalX) + "px")
        .style("top",  Math.max(pad, finalY) + "px")
        .style("max-width", naturalWidth + "px")
        .html(
          `<strong>${courseData.id}: ${courseData.name}</strong>`
          + `<br/>Prerequisites: ${prq?.join(' ') || 'None'}`
          + (courseData.description ? `<br/><br/>${shortDesc(courseData.description)}` : '')
          + missingHtml
        )
        .style("visibility", "visible");

      setTimeout(() => Tooltip.style("visibility", "hidden"), 3000);
    }
  }
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

    return (isAnySourceTaken && isTargetAccessible) ? "black" : "#c8cdd2"
  }

  // Apply colors to edge paths
  d3.select("#links").selectAll("path")
    .attr("stroke", getLinkColor)
    .attr("opacity", d => getLinkColor(d) === "black" ? 0.9 : .5); // Pop active paths!

  // Apply colors to structural triangle pointer markers
  d3.select("#arrows").selectAll("path")
    .attr("fill", getLinkColor);
}

// Expose so index.html script block can call it
window.recomputeAllNodeColors = recomputeAllNodeColors;

// Run once on load so unavailable courses start gray
recomputeAllNodeColors();


// ==================================================
// Course Search Engine & Spatial Interaction Logic
// ==================================================

let activeSearchIndex = 0; 
let currentMatches = [];

// Listen for keyboard entry typing sequences
searchInput.on("input", function(event) {
  const query = event.target.value.toLowerCase().trim();
  searchDropdown.html("");
  activeSearchIndex = 0; 

  if (!query) {
    searchDropdown.style("display", "none");
    return;
  }

  currentMatches = data.filter(course => 
    course.id.toLowerCase().includes(query) || 
    course.name.toLowerCase().includes(query)
  );

  if (currentMatches.length === 0) {
    searchDropdown.style("display", "none");
    return;
  }

  // Populate dynamic dropdown list
  currentMatches.forEach((course, idx) => {
    searchDropdown.append("li")
      .attr("class", `search-item item-${idx}`)
      .text(`${course.id}: ${course.name}`)
      .on("click", () => selectSearchedCourse(course))
      
      // --- HANDOFF RULE 1: Mouse movement overrides and clears keyboard highlight ---
      .on("mousemove", function() {
        // Clear out all highlights everywhere first
        searchDropdown.selectAll(".search-item").classed("active", false).classed("hovered", false);
        
        // Sync our tracking index to the mouse position so pressing Enter still works perfectly
        activeSearchIndex = idx;
        
        // Light up this specific item row with the subtle mouse style
        d3.select(this).classed("hovered", true);
      })
      
      // Clear highlight when the cursor completely exits the dropdown panel bounds
      .on("mouseleave", function() {
        d3.select(this).classed("hovered", false);
      });
  });

  searchDropdown.style("display", "block");

  // Highlight the first element immediately upon drawing the dropdown list
  updateDropdownSelection();
});

// Handle arrow controls and instant Enter key selection
searchInput.on("keydown", function(event) {
  if (searchDropdown.style("display") === "none" || currentMatches.length === 0) return;

  // --- HANDOFF RULE 2: Arrow keys instantly override and clear mouse hover states ---
  if (event.key === "ArrowDown") {
    event.preventDefault();
    searchDropdown.selectAll(".search-item").classed("hovered", false); // Kill mouse visual
    activeSearchIndex = (activeSearchIndex + 1) % currentMatches.length;
    updateDropdownSelection();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    searchDropdown.selectAll(".search-item").classed("hovered", false); // Kill mouse visual
    activeSearchIndex = (activeSearchIndex - 1 + currentMatches.length) % currentMatches.length;
    updateDropdownSelection();
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (activeSearchIndex >= 0 && activeSearchIndex < currentMatches.length) {
      selectSearchedCourse(currentMatches[activeSearchIndex]);
    }
  } else if (event.key === "Escape") {
    closeSearchDropdown();
  }
});

// Cleanly applies the dark .active class to the correctly tracked item row
function updateDropdownSelection() {
  // Clear out both state classes everywhere to guarantee a clean baseline
  searchDropdown.selectAll(".search-item").classed("active", false).classed("hovered", false);

  const activeItem = searchDropdown.select(`.item-${activeSearchIndex}`);
  if (!activeItem.empty()) {
    activeItem.classed("active", true);
    activeItem.node().scrollIntoView({ block: "nearest" });
  }
}

function closeSearchDropdown() {
  searchDropdown.style("display", "none");
  searchInput.node().value = "";
}

// Global click monitoring to close search when clicking canvas whitespace
d3.select("body").on("click.search-close", function(event) {
  if (!searchWrapper.node().contains(event.target)) {
    searchDropdown.style("display", "none");
  }
});

// --- Core Target Evaluation Handler ---
function selectSearchedCourse(course) {
  closeSearchDropdown();

  // 1. Locate the correct rendered canvas graphical elements
  let targetedNodeGroup = null;
  svg.select("#nodes").selectAll("g").each(function(d) {
    if (d.data.id === course.id) {
      targetedNodeGroup = d3.select(this);
    }
  });

  if (!targetedNodeGroup || targetedNodeGroup.empty()) return;

  const nodeDatum = targetedNodeGroup.datum();
  const svgElement = document.getElementById("svg");
  
  // 2. Compute Spatial Viewport Coordinates
  const svgRect = svgElement.getBoundingClientRect();
  const currentTransform = d3.zoomTransform(svgElement);

  // Translate node spatial position coordinates to live screen pixels
  const targetScreenX = currentTransform.applyX(nodeDatum.x);
  const targetScreenY = currentTransform.applyY(nodeDatum.y);

  // 3. Evaluate Visibility Boundaries
  // Margin buffers ensure a course is not considered "visible" if clipped at screen edge
  const marginX = 80;
  const marginY = 40;
  
  const isFullyVisible = 
    targetScreenX >= marginX && 
    targetScreenX <= (svgRect.width - marginX) &&
    targetScreenY >= marginY && 
    targetScreenY <= (svgRect.height - marginY);

  // Action B vs C: Reset zoom only if the target is out of boundaries
  if (!isFullyVisible) {
    svg.transition()
      .duration(500)
      .call(zoom.transform, d3.zoomIdentity); // Safe identity reset matrix
  }

  // 4. Trigger Structural Highlight Ring Animation Sequence
  triggerHighlightRing(targetedNodeGroup);
}

function triggerHighlightRing(nodeGroup) {
  // Append temporary visual ring animation element
  const ring = nodeGroup.append("circle")
    .attr("class", "search-highlight-ring")
    .attr("r", baseNodeRadius * 1.5) // Radiates comfortably outward past rect box parameters
    .attr("fill", "none")
    .attr("stroke", "#d16b05") // Accent coloring contrast that pulls your focus instantly
    .attr("stroke-width", 4)
    .attr("opacity", 1);

  // Smooth pulse loop transition sequence
  ring.transition()
    .duration(1000)
    .attr("opacity", 0.2)
    .transition()
    .duration(1000)
    .attr("opacity", 0)
    .remove(); // Clean up from the DOM immediately upon completion
}
