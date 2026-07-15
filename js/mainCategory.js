console.log("mainCategory.js is running...");
/**
 * Category-based counterpart to main.js.
 *
 * Rendering (nodes, links, arrows, tooltips, coloring, sidebar checkboxes)
 * is identical to main.js — none of that logic cares whether a "group"
 * came from matching prerequisite shape or from a subject-area tag. Only
 * two things differ, both isolated to Phase 1/2 below:
 *   - clusterNodesCategory() instead of clusterNodes() (Phase 1: grouping)
 *   - buildCategoryLayoutNodes() instead of buildLayoutNodes(), plus a
 *     wider grid (colsFn) for category boxes that can hold many courses
 *     (Phase 2: layout DAG)
 *
 * Use this for majors organized by subject-area category rather than a
 * strict prerequisite chain (e.g. Political Science). Use main.js for
 * process-based majors with real prerequisite chains (e.g. Chemistry).
 */

import * as d3 from "https://cdn.skypack.dev/d3@7.8.4";
import * as d3dag from "https://cdn.skypack.dev/d3-dag@1.0.0-1";
import { clusterNodesCategory, primaryCategory } from './clusterNodesCategory.js';
import {
  buildCategoryLayoutNodes,
  createRoleAwareLayoutNodeSize,
  expandLayoutToCourseGraph,
  fitGraphToViewport,
} from './groupLayoutCategory.js';

const data = await d3.json("data/political-science/courses_output_political_science.json");

// Category boxes can hold far more members than a process-based group ever
// would (e.g. "american-politics" has a dozen-plus courses), so give them
// more columns than the default 1/2-column grid: roughly sqrt(n), clamped
// so boxes don't get absurdly wide.
function categoryCols(memberCount) {
  return Math.min(4, Math.max(2, Math.ceil(Math.sqrt(memberCount))));
}

// ------------------- //
// Phase 1: Grouping   //
// ------------------- //
// computeVisualGroups returns metadata only — no DAG mutation.
// visualGroups: array of group descriptors (one per category)
// nodeToGroupId: Map<nodeId, groupId> for O(1) lookup
// edgeMap: same edge styling map as the process-based pipeline

const { visualGroups, nodeToGroupId, edgeMap } = clusterNodesCategory(data);

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
// Collapse categories to one Sugiyama node each (parentIds remapped to
// category ids, self-references dropped, cross-category cycles guarded
// against). After layout, expand back to all courses for rendering.

const baseNodeRadius = 33;
const nodeW = baseNodeRadius * 3.1;
const nodeH = baseNodeRadius * 1.1;
const INTRA_GROUP_VERTICAL_GAP = 2;

const stratify = d3dag.graphStratify()
  .id(d => d.id)
  .parentIds(d => d.parentIds || []);

const layoutNodes = buildCategoryLayoutNodes(data, visualGroups, nodeToGroupId);

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
const layoutNodeSize = createRoleAwareLayoutNodeSize(nodeW, nodeH, INTRA_GROUP_VERTICAL_GAP, categoryCols);
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
    { nodeW, nodeH, gap: INTRA_GROUP_VERTICAL_GAP, colsFn: categoryCols },
  );
} catch (err) {
  console.error('Error building course DAG:', err);
  throw err;
}

const { width, height } = fitGraphToViewport(graph, nodeW, nodeH); //kpw

// ------------------------------ //
// Phase 4b: Deduplicate edges     //
// ------------------------------ //
// For grouped nodes, collapse redundant parallel edges into one
// representative visual edge per logical group connection.

function buildVisualLinks(graph, visualGroups, nodeToGroupId) {
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

    const logicalSrc = srcGroup ?? srcId;
    const logicalTgt = tgtGroup ?? tgtId;
    const key = `${logicalSrc}-->${logicalTgt}`;

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
    incomingList.sort((a, b) => a.sourceX - b.sourceX);

    const count = incomingList.length;
    const firstItem = incomingList[0];
    const visualTarget = firstItem.link.target;

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

      let xOffset = 0;
      if (count > 1) {
        xOffset = ((index / (count - 1)) - 0.5) * usableWidth;
      }

      const halfH = baseNodeRadius / 2;

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

const trans = svg.transition().duration(500);

const nodeById = new Map();
graph.nodes().forEach(n => nodeById.set(n.data.id, n));

const GROUP_PADDING = 2;

const groupBoxes = svg.select("#groups")
  .selectAll("rect.visual-group")
  .data(visualGroups)
  .join("rect")
  .attr("class", "visual-group")
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
visualLinks.forEach(link => {
  if (link.srcGroup) {
    const boxEl = document.querySelector(`rect[data-group-id="${link.srcGroup}"]`);
    if (boxEl) {
      const bx = parseFloat(boxEl.getAttribute("x"));
      const by = parseFloat(boxEl.getAttribute("y"));
      const bw = parseFloat(boxEl.getAttribute("width"));
      const bh = parseFloat(boxEl.getAttribute("height"));

      link.points[0] = [bx + bw / 2, by + bh];
    }
  }

  if (link.tgtGroup) {
    const boxEl = document.querySelector(`rect[data-group-id="${link.tgtGroup}"]`);
    if (boxEl) {
      const bx = parseFloat(boxEl.getAttribute("x"));
      const by = parseFloat(boxEl.getAttribute("y"));
      const bw = parseFloat(boxEl.getAttribute("width"));

      const gapBuffer = 6;

      const targetX = bx + bw / 2 + link.xOffset;
      const targetY = by - gapBuffer;

      link.points[link.points.length - 1] = [targetX, targetY];
    }
  }

  if (link.points.length > 2) {
    const startY = link.points[0][1];
    const endY = link.points[link.points.length - 1][1];
    link.points = link.points.filter(p => p[1] <= endY && p[1] >= startY);
    link.points.unshift([link.points[0][0], link.points[0][1]]);
    link.points.push([link.points[link.points.length - 1][0], link.points[link.points.length - 1][1]]);
  }
});

// --- Nodes ---

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
            .attr("stroke", (d) =>  d.data.group.includes("cultural_diversity") ? "brown" : "white")
            .attr("stroke-width", 2);

          const label = d.data.id;
          const textEl = g.append("text")
            .attr("font-weight", "bold")
            .attr("font-size", "12px")
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
  .on("mouseover", (event, d) => {
    Tooltip
      .html(`<strong>${d.data.id}: ${d.data.name}</strong><br/>
             Prerequisites: ${d.data.PRQ?.join(' ') || 'None'}<br/>
             Description: ${d.data.description|| ''}`) //Description: ${d.data.description.slice(0, 120) || ''}...`)
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
    .attr("d", d => {
      if (d.tgtGroup) {
        return makePath(d.points, 0);
      }
      return makePath(d.points, 7);
    })
      .attr("fill", "none")
      .attr("stroke-width", 3)
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
      const pathNodes = svg.select("#links").selectAll("path").nodes();
      const correspondingPath = pathNodes[i];

      if (!correspondingPath) return;

      const totalLength = correspondingPath.getTotalLength();

      const p2 = correspondingPath.getPointAtLength(totalLength);
      const p1 = correspondingPath.getPointAtLength(Math.max(0, totalLength - 0.5));

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;

      let angle = 0;
      if (dx !== 0 || dy !== 0) {
        angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      }

      d3.select(this)
        .attr("transform", `translate(${p2.x}, ${p2.y}) rotate(${angle})`);
    })
    .call(enter => enter.transition(trans).attr("opacity", 1));

// ----------------------- //
// Sidebar: populate lists //
// ----------------------- //

function populateSidebar(data) {
  const sorted = [...data].sort((a, b) => a.id.localeCompare(b.id));

  sorted.forEach(course => {
    // Category-based majors can tag a course with multiple groups
    // (e.g. "cultural_diversity, american-politics") and some courses
    // carry no group at all. Use the same placement rule the graph
    // clustering uses (primaryCategory) so the sidebar list a course
    // appears under always matches the box it's drawn in, and fall back
    // to an "other" bucket for untagged courses instead of silently
    // dropping them.
    const listKey = primaryCategory(course.group) ?? 'other';
    const container = document.getElementById(`list-${listKey}`);
    if (!container) {
      //console.warn(`No sidebar list for group "${listKey}" (${course.id})`);
      return;
    }

    const label = document.createElement('label');
    label.className = 'course-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.courseId = course.id;
    checkbox.dataset.group = listKey;
    checkbox.onchange = function() {
      recomputeAllNodeColors(this);
      updateGroupCheckbox(listKey);
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

function evaluatePrerequisites(tokens, takenSet) {
  if (!tokens || tokens.length === 0) return true;

  function matchParen(toks, i) {
    let depth = 0;
    for (let j = i; j < toks.length; j++) {
      if (toks[j] === '(') depth++;
      else if (toks[j] === ')') { depth--; if (depth === 0) return j; }
    }
    return toks.length - 1;
  }

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

    if (toks[0] === '(' && matchParen(toks, 0) === toks.length - 1) {
      return evaluate(toks.slice(1, toks.length - 1));
    }

    const orClauses = splitBy(toks, 'or');
    if (orClauses.length > 1) {
      return orClauses.some(clause => evaluate(clause));
    }

    const andClauses = splitBy(toks, 'and');
    if (andClauses.length > 1) {
      return andClauses.every(clause => evaluate(clause));
    }

    if (toks.length === 1) {
      const courseId = toks[0].trim();
      return takenSet.has(courseId);
    }
    const courseId = toks.join(' ').trim();
    return takenSet.has(courseId);
  }

  return evaluate(tokens);
}

function getTakenSet() {
  const taken = new Set();
  document.querySelectorAll('input[type="checkbox"][data-course-id]').forEach(cb => {
    if (cb.checked) taken.add(cb.dataset.courseId);
  });
  return taken;
}

function recomputeAllNodeColors() {
  const takenSet = getTakenSet();
  const isInitialState = (takenSet.size === 0);

  const nodeStates = new Map();

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

    const finalColor = isInitialState ? NODE_COLOR.available : NODE_COLOR[state];
    d3.select(this).select("rect.course-rect").attr("fill", finalColor);
  });

  const groupMembersMap = new Map();
  visualGroups.forEach(g => {
    groupMembersMap.set(g.id, g.memberIds);
  });

  function getLinkColor(d) {
    if (isInitialState) {
      return "black";
    }

    const srcId = d.source.data.id;
    const tgtId = d.target.data.id;

    const srcGroupId = nodeToGroupId.get(srcId);
    const sourceCoursesToCheck = srcGroupId ? (groupMembersMap.get(srcGroupId) ?? [srcId]) : [srcId];

    const tgtGroupId = nodeToGroupId.get(tgtId);
    const targetCoursesToCheck = tgtGroupId ? (groupMembersMap.get(tgtGroupId) ?? [tgtId]) : [tgtId];

    const isTargetAccessible = targetCoursesToCheck.some(id => {
      const state = nodeStates.get(id);
      return state === "taken" || state === "available";
    });
    const isAnySourceTaken = sourceCoursesToCheck.some(id => takenSet.has(id));

    return (isAnySourceTaken && isTargetAccessible) ? "black" : "#e2e8f0"
  }

  d3.select("#links").selectAll("path")
    .attr("stroke", getLinkColor)
    .attr("opacity", d => getLinkColor(d) === "black" ? 0.9 : 0.35);

  d3.select("#arrows").selectAll("path")
    .attr("fill", getLinkColor);
}

window.recomputeAllNodeColors = recomputeAllNodeColors;

recomputeAllNodeColors();