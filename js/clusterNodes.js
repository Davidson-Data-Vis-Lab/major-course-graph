function clusterNodes(nodes) {
  // Helper function to create a sorted string key from an array
  function createKey(arr) {
    return [...arr].sort().join('|') || 'EMPTY';
  }
  
  // First, we need to identify children for each node
  const childrenMap = new Map();
  
  // Initialize all nodes with empty children arrays
  nodes.forEach(node => {
    childrenMap.set(node.id, { 'children': []});
  });
   // Make a map of the edges and their types (source, target, type)
  const edgeMap = new Map();
  // Populate children by looking at parent relationships
  // Loop through each node
  // Go through the node's parents
  // if the parentId is in the children map
  // then add the current node as a child to the parent in the map
  nodes.forEach(node => {
    node.parentIds.forEach(parentId => {
      if (childrenMap.has(parentId)) {
        childrenMap.get(parentId).children.push(node.id);
      }
    });
    determineParentEdgeType(node, edgeMap); 
  });
  
  /**
   * Now we have all of the parent and child relationships. We can lookup 
   * both the node's parents and children (if they exist).
   * 
   * We want to distinguish which nodes are leafs (no children) and which
   * are non-leaf nodes (have children).
   * 
   * This impacts our clustering later. We want to cluster if nodes have the 
   * same parents AND same children. We also want to cluster if the nodes
   * have the same parents (leaf nodes only).
   */
  // Separate leaf nodes from non-leaf nodes
  const leafNodes = [];
  const nonLeafNodes = [];
  
  nodes.forEach(node => {
    const children = childrenMap.get(node.id).children || [];
    if (children.length === 0) {
      leafNodes.push({...node, children});
    } else {
      nonLeafNodes.push({...node, children});
    }
  });

 
  const visualGroups = []; // array of individual nodes and "clustered" groups
  const nodeToGroupId = new Map();
  let groupCounter = 0;

  //Grouping non-leaf nodes (same parents AND same children)
  const nonLeafGroups = new Map();
  nonLeafNodes.forEach(node => {
    const parentKey = createKey(node.parentIds);
    const childrenKey = createKey(node.children);
    // capture the parent-child relationship
    const combinedKey = `${parentKey}__${childrenKey}`;

    if (!nonLeafGroups.has(combinedKey)) {
      nonLeafGroups.set(combinedKey, []);
    }
    nonLeafGroups.get(combinedKey).push(node);
  });

  nonLeafGroups.forEach(arrOfNodes => {
    if(arrOfNodes.length > 1){
      const groupId = `group_${groupCounter++}`;
      const parentIds = arrOfNodes[0].parentIds;
      const childIds = arrOfNodes[0].children;
      const clusteredGroup = {
        id: groupId,
        reason: 'same_parents_and_children',
        members: arrOfNodes,
        memberIds: arrOfNodes.map(n => n.id),
        parentIds,
        childIds,
        role: parentIds.length === 0 ? 'root' : 'leaf',
      };

      visualGroups.push(clusteredGroup);
      arrOfNodes.forEach(n => nodeToGroupId.set(n.id, groupId));
    }
  });


  //Grouping leaf nodes (same parents only, no children)
  const leafGroups = new Map();
  leafNodes.forEach(node => {
    const parentKey = createKey(node.parentIds);
    
    if (!leafGroups.has(parentKey)) {
      leafGroups.set(parentKey, []);
    }
    leafGroups.get(parentKey).push(node);
  });

  leafGroups.forEach(arrOfNodes => {
    if(arrOfNodes.length > 1){
      const groupId = `group_${groupCounter++}`;
      const parentIds = arrOfNodes[0].parentIds;
      const clusteredGroup = {
        id: groupId,
        reason: 'same_parents_leaf_nodes',
        members: arrOfNodes,
        memberIds: arrOfNodes.map(n => n.id),
        parentIds,
        childIds: [],
        role: parentIds.length === 0 ? 'root' : 'leaf',
      };
      visualGroups.push(clusteredGroup);
      arrOfNodes.forEach(n => nodeToGroupId.set(n.id, groupId));
    }
  });

  return {visualGroups, nodeToGroupId, edgeMap}

}

function findMatching(tokens, i) {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j] === '(') depth++;
    else if (tokens[j] === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  throw new Error(`Unmatched "(" at ${i}`);
}

function parseGroup(tokens, target) {
  const hasOr  = tokens.includes('or');
  const hasAnd = tokens.includes('and');
  const style  = !hasOr ? 'solid' : (!hasAnd ? 'dashed' : 'solid');
  let out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '(') {
      const j = findMatching(tokens, i);
      out.push(...parseGroup(tokens.slice(i + 1, j), target));
      i = j + 1;
    } else if (t === 'and' || t === 'or' || t === ')') {
      i++;
    } else {
      out.push({ source: t, target, style });
      i++;
    }
  }
  return out;
}

function determineParentEdgeType(node, edgeMap) {
  const incomingEdgesList = parseGroup(node.PRQ, node.id);
  for (const { source, target, style } of incomingEdgesList) {
    if (!edgeMap.has(source)) edgeMap.set(source, []);
    edgeMap.get(source).push({ target, style });
  }
}

export { clusterNodes, parseGroup, findMatching };

