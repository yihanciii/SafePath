import pandas as pd
import networkx as nx


class RouteEngine:
    """
    Build the road network from the CSV with edge_id, u, v, risk_score
    And provide the safest_path method to calculate the safest path based on risk weights.
    """

    def __init__(self, edges_csv_path: str):
        self.edges_csv_path = edges_csv_path
        self.graph = nx.Graph()
        self._build_graph()

    def _build_graph(self):
        df = pd.read_csv(self.edges_csv_path)

        # Only retain the necessary columns to prevent the influence of redundant columns
        df_edges = df[["edge_id", "u", "v", "risk_score"]].copy()

        # Optional: Convert the node and edge_id to int to avoid float64 having decimal points
        df_edges["u"] = df_edges["u"].astype(int)
        df_edges["v"] = df_edges["v"].astype(int)
        df_edges["edge_id"] = df_edges["edge_id"].astype(int)

        for _, row in df_edges.iterrows():
            u = row["u"]
            v = row["v"]
            risk = row["risk_score"]
            eid = row["edge_id"]

            self.graph.add_edge(u, v, risk=risk, edge_id=eid)

    def safest_path(self, source, target):
        """
        Return (node path, edge ID path) based on the risk weight
        source, target: Node id (consistent with u/v in CSV)
        """
        path_nodes = nx.shortest_path(
            self.graph,
            source=source,
            target=target,
            weight="risk"
        )

        path_edge_ids = []
        for u, v in zip(path_nodes[:-1], path_nodes[1:]):
            edge_data = self.graph[u][v]
            path_edge_ids.append(edge_data["edge_id"])

        return path_nodes, path_edge_ids
