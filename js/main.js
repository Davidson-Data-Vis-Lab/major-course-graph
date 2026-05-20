console.log("main.js is running...");
/**
 * Based on Erik Brinkman's https://codepen.io/brinkbot/pen/oNQwNRv
 * 
 * 
 */

import * as d3 from "https://cdn.skypack.dev/d3@7.8.4";
window.d3 = d3;
import * as d3dag from "https://cdn.skypack.dev/d3-dag@1.0.0-1";
import { buildClusteredGraph } from './createClusteredGraphBuilder.js';

const data = await d3.json("data/courses-full-info.json");
/**
 * Arrow transform function
 */
function arrowTransform(linkData) {
    const points = linkData.points;
    const lastTwoPoints = points.slice(-2);
    const [x1, y1] = lastTwoPoints[0];
    const [x2, y2] = lastTwoPoints[1];
    
    const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 90;
    return `translate(${x2}, ${y2}) rotate(${angle})`;
}

// -------------- //
// Compute Layout //
// -------------- //

const graphInfo = buildClusteredGraph(data);
const graph = graphInfo.graph;
const edgeMap = graphInfo.edgeMap;

// set the layout functions
const baseNodeRadius = 33;  // reduced from 40 to 25
const nodeSize = [baseNodeRadius * 3.1, baseNodeRadius * 1.1];
const shape = d3dag.tweakShape(nodeSize, d3dag.shapeRect);
const line = d3.line().curve(d3.curveMonotoneY); // Can adjust lines here


// here's the layout operator, uncomment some of the settings
const layout = d3dag
    .sugiyama()
    .layering(d3dag.layeringSimplex())
    .nodeSize(nodeSize)
    .gap([baseNodeRadius, baseNodeRadius * 1.5])  
    .tweaks([shape]);


// actually perform the layout and get the final size
const { width, height } = layout(graph);
// --------- //
// Rendering //
// --------- //

// global
const svg = d3
  .select("#svg")
  // pad a little for link thickness
  .style("width", width + 4)
  .style("height", height + 50);
const trans = svg.transition().duration(500);


// Create legend

const legend = svg.append("g")
    .attr("class", "legend")
    .attr("transform", `translate(20, 20)`);
// Add legend items below
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
    // Rectangles for course availability
    g.each(function(d) {
      const group = d3.select(this);
      if (d.type === "box") {
        group.append("rect")
          .attr("x", -6)
          .attr("y", -6)
          .attr("width", 12)
          .attr("height", 12)
          .attr("fill", d.color)
          .attr("stroke", "white")
          .attr("stroke-width", 1);
      } else if (d.type === "line") {
        group.append("line")
          .attr("x1", -6)
          .attr("x2", 6)
          .attr("y1", 0)
          .attr("y2", 0)
          .attr("stroke", "black")
          .attr("stroke-width", 2)
          .attr("stroke-dasharray", d.dash);
      }

      group.append("text")
        .attr("x", 12)
        .attr("y", 0)
        .attr("dy", "0.35em")
        .style("font-family", "sans-serif")
        .style("font-size", "10px")
        .style("fill", "#333")
        .text(d.key);
    });
  });

    

// Render nodes with different styles for clusters
svg.select("#nodes")
    .selectAll("g")
    .data(graph.nodes())
    .join(enter =>
        enter.append("g")
            .attr("transform", ({ x, y }) => `translate(${x}, ${y})`)
            .attr("opacity", 0)
            .style("cursor", "pointer")
            .call(enter => {
                // Different rendering for clusters vs individual nodes
                enter.each(function(d) {
                    const g = d3.select(this);
                    const isCluster = d.data.isCluster;
                    const nodeRadius = baseNodeRadius;
                    
                    if (isCluster) {
                        // Cluster node - larger rectangle with dashed border
                        var rectWidth = nodeRadius * 2.2;
                        const courseCount = d.data.clusterMembers.length;
                        const lineHeight = 16; // Height per course line
                        const padding = 15; // Top and bottom padding
                        const rectHeight = (courseCount * lineHeight) + padding;
                        d.data.clusterMembers.forEach(node => {
                            rectWidth = (node.length > 7) ? rectWidth * 1.4 : rectWidth;
                        });
                        
                        g.append("rect")
                            .attr("x", -rectWidth / 2)
                            .attr("y", -rectHeight / 2 + (lineHeight * (courseCount/2 - 1)))
                            .attr("width", rectWidth)
                            .attr("height", rectHeight)
                            .attr("rx", 6)
                            .attr("ry", 6)
                            .attr("fill", 'steelblue') //colorMap.get(d.data.id))
                            .attr("stroke", "white")
                            .attr("stroke-width", 3);
                            
                        
                        // Cluster size indicator
                        const textGroup = g.append("g");
                        d.data.clusterMembers.forEach((courseName, index) => {
                            textGroup.append("text")
                                .text(courseName)
                                .attr("x", 0)
                                .attr("y", -rectHeight / 2 + (lineHeight * (courseCount/2 - 1)) + padding + (index * lineHeight))
                                .attr("font-weight", "bold")
                                .attr("font-family", "sans-serif")
                                .attr("font-size", "12px")
                                .attr("text-anchor", "middle")
                                .attr("alignment-baseline", "middle")
                                .attr("fill", "white")
                                .style("pointer-events", "none");
                        });
                        
                    } else {
                        // Individual node - rectangle
                        var rectWidth = nodeRadius * 2.2;
                        const rectHeight = nodeRadius;
                        rectWidth = (d.data.id.length > 7) ? rectWidth * 1.4 : rectWidth;
                        
                        g.append("rect")
                            .attr("x", -rectWidth / 2)
                            .attr("y", -rectHeight / 2)
                            .attr("width", rectWidth)
                            .attr("height", rectHeight)
                            .attr("rx", 6)
                            .attr("ry", 6)
                            .attr("fill", 'steelblue')//colorMap.get(d.data.id))
                            .attr("stroke", "white")
                            .attr("stroke-width", 2)
                            .attr("id", (d)=> d.data.id);
                        
                        g.append("text")
                            .text(d.data.id)
                            .attr("font-weight", "bold")
                            .attr("font-family", "sans-serif")
                            .attr("font-size", "12px")
                            .attr("text-anchor", "middle")
                            .attr("alignment-baseline", "middle")
                            .attr("fill", "white")
                            .style("pointer-events", "none");
                    }
                    

               
                    const Tooltip = d3.select("body").append("div")
                    .attr("class", "tooltip")       
                    .style("position", "absolute")
                    .style("padding", "6px 10px")
                    .style("background", "#eaeded")
                    .style("color", "black")
                    .style("border-radius", "4px")
                    .style("border-style","solid")
                    .style("font-size", "20px")
                    .style("pointer-events", "none")
                    .style("visibility", "hidden");

                    
                    svg.select("#nodes").selectAll("g")
                    .on("click", (event, d) => {
                        Tooltip
                        .html(displayTooltip(d))                   
                        .style("top",    (event.pageY + 10) + "px") 
                        .style("left",   (event.pageX + 10) + "px")
                        .style("visibility", "visible");           
                    })
                    .on("mouseout", () => {
                        Tooltip.style("visibility", "hidden");
                    });

                    function displayTooltip(d) {
                        if (d.data.isCluster) {
                            const idToCourse = Object.fromEntries(
                            data.map(c => [c.id, c.name])
                            );
                            const memberLines = d.data.clusterMembers.map(id =>
                            `${id}: ${idToCourse[id] || 'Unknown'}`
                            );
                            return [
                            `<strong>Cluster (${d.data.clusterSize} courses)</strong>`,
                            ...memberLines,
                            `Prerequisites: ${d.data.parentIds?.join(', ') || 'None'}`
                            ].join('<br/>');
                        } else {
                            var nodePrerequisites= d.data.originalNode.PRQ;
                            return [
                            `<strong>${d.data.id}: ${d.data.name}</strong>`,
                            `Prerequisites: ${nodePrerequisites?.join(' ') || 'None'}`
                            ].join('<br/>');
                        }
                        }
                 
                });
                
                enter.transition(trans).attr("opacity", 1);
            })
            // .on("click", function(event, d) {
            //     toggleGroupHighlight(assignNodeGroup(d));
            // })
    );


// link paths
svg
  .select("#links")
  .selectAll("path")
  .data(graph.links())
  .join((enter) =>
    enter
      .append("path")
      .attr("d", ({ points }) => line(points))
      .attr("fill", "none")
      .attr("stroke-width", 3)
      .attr("stroke-dasharray", (d) => {
        var allEdgeInfo = edgeMap.get(d.source.data.id);
        if (allEdgeInfo) {
            var edgeTarget = d.target.data.id;
            const edgeInfo = allEdgeInfo.find(edge => edge.target === edgeTarget);
            return (edgeInfo) && (edgeInfo.style == "dashed") ? '5px' : "50%";
        }
        return '50%';
      })
      .attr( "stroke", "black")
      .attr("opacity", 0)
      .call((enter) => enter.transition(trans).attr("opacity", 0.7))
  );

// Arrows
const arrowSize = 80;
const arrowLen = Math.sqrt((4 * arrowSize) / Math.sqrt(3));
const arrow = d3.symbol().type(d3.symbolTriangle).size(arrowSize);
svg
  .select("#arrows")
  .selectAll("path")
  .data(graph.links())
  .join((enter) =>
    enter
      .append("path")
      .attr("d", arrow)
      .attr("fill",  "black") //({ target }) => colorMap.get(target.data.id)!)
      .attr("transform", arrowTransform)
      .attr("opacity", 0.7)
      .attr("stroke", "white")
      .attr("stroke-width", 2)
      // use this to put a white boundary on the tip of the arrow
      .attr("stroke-dasharray", `${arrowLen},${arrowLen}`)
      .call((enter) => enter.transition(trans).attr("opacity", 1))
  );
