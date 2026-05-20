import * as d3dag from "https://cdn.skypack.dev/d3-dag@1.0.0-1";
import { clusterNodes } from './clusterNodes.js';

// Example usage with your clustering function and d3-dag
function buildClusteredGraph(originalData) {
  // Step 1: Cluster the nodes
  const clusterResult = clusterNodes(originalData);
  var clusteredData = clusterResult.clusteredNodes;
  var edgeMap = clusterResult.edgeMap;

  // KEEP: Optional print statements to view the clustering algorithm results
    console.log("Clustering Results:");
    console.log(`Original nodes: ${clusterResult.originalNodeCount}`);
    console.log(`After clustering: ${clusterResult.clusteredNodeCount}`);
    console.log(`Clusters created: ${clusterResult.clustersCreated}`);
    console.log("\nClusters created:");
    clusteredData
    .filter(node => node.type === 'cluster')
    .forEach((cluster, index) => {
        console.log(`\nCluster ${index + 1}:`);
        console.log(`  ID: ${cluster.id}`);
        console.log(`  Members: ${cluster.members.join(', ')}`);
        console.log(`  Reason: ${cluster.reason}`);
        console.log(`  EdgeType: ${cluster.edgeType}`);
        console.log(`  Parent IDs: ${cluster.parentIds.join(', ') || 'None'}`);
        if (cluster.reason === 'same_parents_and_children') {
        console.log(`  Children: ${cluster.children.join(', ') || 'None'}`);
        }
    });
    clusteredData
    .filter(node => node.type !== 'cluster')
    .forEach((node, index) => {
        console.log(`ID: ${node.id}`);
        console.log(`  EdgeType: ${node.edgeType}`)
        console.log(`  Parent IDs: ${node.parentIds.join(', ') || 'None'}`);
    });

    
  // Step 2: Create the builder
  const builder = createClusteredGraphBuilder();
  
  // Step 3: Build the graph
  const graph = builder(clusteredData);
  
  return {graph, edgeMap}
}

function createClusteredGraphBuilder() {
  return function(clusteredNodes) {
    // Create mapping from original node ID to cluster (if it exists)
    const nodeToClusterMap = new Map();
    const clusterNodes = [];
    const individualNodes = [];
    
    // Separate clusters from individual nodes and build mapping
    clusteredNodes.forEach(node => {
      if (node.type === 'cluster') {
        clusterNodes.push(node);
        // Map each member to this cluster
        node.members.forEach(memberId => {
          nodeToClusterMap.set(memberId, node.id);
        });
      } else {
        individualNodes.push(node);
        // Map the node to itself (not clustered)
        nodeToClusterMap.set(node.id, node.id);
      }
    });

    // Helper function to resolve parent IDs to cluster IDs or individual IDs
    function resolveParentIds(originalParentIds) {
      const resolvedParents = new Set();
      
      originalParentIds.forEach(parentId => {
        const resolvedParent = nodeToClusterMap.get(parentId);
        if (resolvedParent) {
          resolvedParents.add(resolvedParent);
        } else {
          // Parent not found in our clustered data, keep original
          resolvedParents.add(parentId);
        }
      });
      
      return Array.from(resolvedParents);
    }
    
    // Build the final graph nodes
    const graphNodes = [];
    let clusterCounter = 0;
    
    // Process individual nodes first
    individualNodes.forEach(node => {
      const resolvedParentIds = resolveParentIds(node.parentIds || []);
      
      graphNodes.push({
        id: node.id,
        name: node.name,
        parentIds: resolvedParentIds,
        group: node.group,
        isCluster: false,
        originalNode: node,
      });
    });
    
    // Process cluster nodes
    clusterNodes.forEach(cluster => {
      const resolvedParentIds = resolveParentIds(cluster.parentIds || []);
      
      // Create a display name from the cluster members
      graphNodes.push({
        id: cluster.id, //`CLUSTER_${clusterCounter}`,
        parentIds: resolvedParentIds,
        group: cluster.group,
        isCluster: true,
        clusterMembers: cluster.members,
        clusterSize: cluster.members.length,
        clusterPRQ: cluster.PRQ
      });
      
      clusterCounter++;
    });
    
    // Create the stratified graph using d3-dag
    // We need to create a custom stratify function that works with our parentIds structure
    const stratify = d3dag.graphStratify()
      .id(d => d.id)
      .parentIds(d => d.parentIds || []);
    
    try {
      const dag = stratify(graphNodes);
      return dag; // End of function


    } catch (error) {
      console.error('Error creating DAG:', error);
      console.log('Graph nodes:', graphNodes);
      throw error;
    }
  };
}

export { createClusteredGraphBuilder, buildClusteredGraph };