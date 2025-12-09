import os
import json
import numpy as np
import pandas as pd
from flask import Flask, request, jsonify
from flask_cors import CORS
from scipy.spatial import cKDTree

from route_engine import RouteEngine
# === MongoDB connection ===
from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017")
db = client["safe_route"]
reports_col = db["reports"]
# make sure we have a 2dsphere index for geo field
reports_col.create_index([("geo", "2dsphere")])


# === Path Settings (Adjust according to your own directory) ===
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Use the full version of CSV for routing
CSV_PATH = os.path.join(
    BASE_DIR,
    "edge_risk_scores_final.csv"
)

# Render the route using geojson
GEOJSON_PATH = os.path.join(
    BASE_DIR,
    "edges.geojson"
)


# === Initialize RouteEngine (load CSV + Build the map) ===
print("[INFO] Loading RouteEngine...")
route_engine = RouteEngine(CSV_PATH)


# ===Load GeoJSON and create the index of edge_id -> feature ===
print("[INFO] Loading edges.geojson...")
with open(GEOJSON_PATH, "r", encoding="utf-8") as f:
    edges_geojson = json.load(f)

print(f"[INFO] Loaded {len(edges_geojson.get('features', []))} features from GeoJSON")

edge_index = {}
for feat in edges_geojson["features"]:
    props = feat.get("properties", {})
    eid = props.get("edge_id")
    if eid is None:
        continue
    try:
        eid_int = int(float(eid))
        edge_index[eid_int] = feat
    except (ValueError, TypeError):
        continue

print(f"[INFO] Built edge_index with {len(edge_index)} edges")


# === Jointly build node_coords from CSV and GeoJSON ===
print("[INFO] Building node_coords from CSV and GeoJSON...")

# 1. Read all (u, v) node pairs from CSV
df_edges = pd.read_csv(CSV_PATH)
all_node_ids = set(df_edges["u"].astype(int).tolist() + df_edges["v"].astype(int).tolist())
print(f"[DEBUG] Found {len(all_node_ids)} unique nodes in CSV")

# 2. Extract all endpoint coordinates from GeoJSON (sorted by edge_id so that it corresponds to CSV)
edge_coords = {}  # edge_id -> (start_coord, end_coord)

for feat in edges_geojson["features"]:
    props = feat.get("properties", {})
    geom = feat.get("geometry", {})
    coords = geom.get("coordinates")
    
    if not coords or geom.get("type") != "LineString":
        continue
    
    edge_id = props.get("edge_id")
    if edge_id is None:
        continue
    
    edge_id = int(float(edge_id))
    start_coord = coords[0]   # [lng, lat]
    end_coord = coords[-1]
    
    edge_coords[edge_id] = (start_coord, end_coord)

print(f"[DEBUG] Extracted coordinates for {len(edge_coords)} edges from GeoJSON")

# 3. Associate the coordinates with the node_id through the edge_id in CSV
node_coords = {}

for _, row in df_edges.iterrows():
    edge_id = int(row["edge_id"])
    u = int(row["u"])
    v = int(row["v"])
    
    if edge_id not in edge_coords:
        continue
    
    start_coord, end_coord = edge_coords[edge_id]
    
    # u corresponds to the starting point, and v corresponds to the ending point
    if u not in node_coords:
        node_coords[u] = start_coord
    if v not in node_coords:
        node_coords[v] = end_coord

print(f"[INFO] Built node_coords with {len(node_coords)} nodes")

if len(node_coords) == 0:
    print("[ERROR] Still no nodes! Check CSV and GeoJSON edge_id alignment.")


# === Build a KD-Tree (for quickly finding the nearest node) ===
print("[INFO] Building KD-Tree for nearest node search...")

node_coords_array = []
node_ids_list = []

for nid, coord in node_coords.items():
    # coord should be [lng, lat]
    if coord and len(coord) == 2:
        node_ids_list.append(nid)
        node_coords_array.append(coord)

node_coords_array = np.array(node_coords_array)

print(f"[DEBUG] node_coords_array shape: {node_coords_array.shape}")


if len(node_coords_array) == 0:
    print("[ERROR] node_coords_array is empty! KD-Tree cannot be built.")
    print("[ERROR] Check if your edges.geojson has 'u' and 'v' fields in properties.")
    kdtree = None
else:
    print(f"[DEBUG] First 3 coords: {node_coords_array[:3]}")
    kdtree = cKDTree(node_coords_array)
    print(f"[SUCCESS] KD-Tree built with {len(node_ids_list)} nodes")


# === Flask app ===
REPORT_RADIUS_METERS = 200
app = Flask(__name__)
CORS(app)

# allow everything during the development stage
CORS(app, resources={r"/*": {"origins": "*"}})


# === Home Page: Display available API interfaces ===
@app.route("/")
def index():
    return jsonify({
        "status": "SafePath Route Engine Running",
        "version": "1.0",
        "endpoints": {
            "nearest_node": "/nearest_node?lng=<lng>&lat=<lat>",
            "route": "/route?start=<node_id>&end=<node_id>",
            "routes_multi": "/routes_multi?start=<node_id>&end=<node_id>&k=3",
            "reports_new": "/reports/new (POST)",
            "reports_nearby": "/reports/nearby?lat=<lat>&lon=<lon>",
            "reports_all": "/reports/all"
        }
    })


# === Find the nearest node based on the coordinates===
@app.route("/nearest_node", methods=["GET"])
def nearest_node():
    if kdtree is None:
        return jsonify({
            "error": "KD-Tree not available. Node coordinates may not be loaded."
        }), 500
    
    try:
        lng = float(request.args.get("lng"))
        lat = float(request.args.get("lat"))
    except (TypeError, ValueError):
        return jsonify({"error": "lng/lat required"}), 400
    

    query_point = [lng, lat]
    distance, index = kdtree.query(query_point)
    
    nearest_node_id = node_ids_list[index]
    nearest_coord = node_coords_array[index].tolist()
    
    return jsonify({
        "node_id": nearest_node_id,
        "coordinates": nearest_coord,
        "distance_degrees": float(distance),
        "distance_meters": float(distance * 111000)
    })


# ===Obtain a single path ===
@app.route("/route", methods=["GET"])
def get_route():
    """
    Calling method：
    /route?start=<node_id>&end=<node_id>
    """
    start = request.args.get("start")
    end = request.args.get("end")

    if start is None or end is None:
        return jsonify({"error": "The start and end parameters need to be provided"}), 400

    try:
        start_node = int(float(start))
        end_node = int(float(end))
    except ValueError:
        return jsonify({"error": "start/end must be the node id"}), 400

    try:
        node_path, edge_ids = route_engine.safest_path(start_node, end_node)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"routing fail: {str(e)}"}), 500

    features = []
    for eid in edge_ids:
        feat = edge_index.get(int(eid))
        if feat:
            features.append(feat)

    route_geojson = {
        "type": "FeatureCollection",
        "features": features,
        "properties": {
            "start": start_node,
            "end": end_node,
            "node_count": len(node_path),
            "edge_count": len(features)
        }
    }

    return jsonify(route_geojson)


# === Obtain multiple candidate paths ===
@app.route("/routes_multi", methods=["GET"])
def get_routes_multi():
    """
    Calling method：
    /routes_multi?start=<node_id>&end=<node_id>&k=3
    """
    start = request.args.get("start")
    end = request.args.get("end")
    k = request.args.get("k", 3)

    if start is None or end is None:
        return jsonify({"error": "start and end are required"}), 400

    try:
        start_node = int(float(start))
        end_node = int(float(end))
        k = int(k)
    except ValueError:
        return jsonify({"error": "start/end/k invalid"}), 400

    try:
        routes = route_engine.safest_k_paths(start_node, end_node, k=k)
        if not routes:
            return jsonify({"error": "no route found"}), 404
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"routing fail: {str(e)}"}), 500

    result_routes = []
    for idx, r in enumerate(routes):
        node_path = r["nodes"]
        edge_ids = r["edges"]
        total_risk = float(r["total_risk"])

        features = []
        for eid in edge_ids:
            feat = edge_index.get(int(eid))
            if feat:
                features.append(feat)

        start_node_id = r["nodes"][0]
        end_node_id   = r["nodes"][-1]

        start_coord = node_coords.get(start_node_id)
        end_coord   = node_coords.get(end_node_id)

        # 👇 Add: Calculate the average risk
        edge_count = len(features)
        avg_risk = total_risk / edge_count if edge_count > 0 else 0.0

        route_geojson = {
            "type": "FeatureCollection",
            "features": features,
            "properties": {
                "start": start_node_id,
                "end": end_node_id,
                "node_count": len(node_path),
                "edge_count": len(features),
                "total_risk": total_risk,
                "avg_risk": avg_risk,  
                "rank": idx
            }
        }

        result_routes.append({
            "id": idx,
            "nodes": node_path,
            "edge_ids": edge_ids,
            "geojson": route_geojson,
            "node_count": len(node_path),
            "edge_count": len(features),
            "total_risk": total_risk,
            "avg_risk": avg_risk, 
            "start_node": start_node_id,
            "end_node": end_node_id,
            "start_coord": start_coord,
            "end_coord": end_coord,
        })
        # ===== sort by average risk from low to high, with the safest route ranked first =====
        # The percentage displayed on the UI is avg_risk * 100, so sorting with avg_risk is the most intuitive
    result_routes.sort(key=lambda r: r["avg_risk"])
    
    # Renumber and reset the rank to ensure that Path 1 is definitely the one with the lowest risk
    for new_idx, r in enumerate(result_routes):
        r["id"] = new_idx
        # Update properties.rank in geojson
        if "geojson" in r and "properties" in r["geojson"]:
            r["geojson"]["properties"]["rank"] = new_idx


    return jsonify({"routes": result_routes})


# === User reports event (POST) ===
@app.route("/reports/new", methods=["POST"])
def new_report():
    data = request.get_json(force=True) or {}

    loc = data.get("location") or {}
    try:
        lat = float(loc.get("lat"))
        lon = float(loc.get("lon"))   
    except (TypeError, ValueError):
        return jsonify({"error": "invalid lat/lon"}), 400

    doc = {
    "location": {
        "lat": lat,
        "lon": lon,
    },
    "geo": {
        "type": "Point",
        "coordinates": [lon, lat],
    },
    "severity": data.get("severity"),
    "category": data.get("category"),
    "details": data.get("details"),
    "timestamp": data.get("timestamp"),
    "status": "submitted",
}


    result = reports_col.insert_one(doc)
    return jsonify({
        "status": "ok",
        "report_id": str(result.inserted_id),
    })



# === Query Nearby Events (GET) - Only verified ones are returned ===
@app.route("/reports/nearby", methods=["GET"])
def find_reports():
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"error": "lat/lon are required"}), 400

    EARTH_RADIUS_METERS = 6378137.0
    radius_radians = REPORT_RADIUS_METERS / EARTH_RADIUS_METERS

    # Only return events whose status = "verified" and are within the radius range
    query = {
        "geo": {
            "$geoWithin": {
                "$centerSphere": [[lon, lat], radius_radians]
            }
        },
        "status": "verified"
    }

    try:
        results = list(reports_col.find(query))
    except Exception as e:
        print("[/reports/nearby] Mongo error:", e)
        return jsonify({"error": str(e)}), 500

    for r in results:
        r["_id"] = str(r["_id"])

    return jsonify(results)



# === Query all events (GET) - only return verified ones ===
@app.route("/reports/all", methods=["GET"])
def get_all_reports():
    """
    Return all verified events
    """
    results = list(reports_col.find({"status": "verified"}))  
    for r in results:
        r["_id"] = str(r["_id"])

    return jsonify(results)

# === New addition: Obtain risk data for all edges (for heat maps)===
@app.route("/edges/risk_data", methods=["GET"])
def get_edges_risk_data():
    """
    Return the risk data of all edges for front-end rendering of the heat map
    Return format: GeoJSON FeatureCollection
    """
    try:
        # Read the CSV to obtain the risk score
        import pandas as pd
        df_edges = pd.read_csv(CSV_PATH)
        
        # Construct the mapping of edge_id -> risk_score
        edge_risk_map = {}
        for _, row in df_edges.iterrows():
            edge_id = int(row["edge_id"])
            risk_score = float(row["risk_score"]) if "risk_score" in row else 0.0
            edge_risk_map[edge_id] = risk_score
        
        # Obtain geometric information from GeoJSON and add risk scores
        features = []
        for feat in edges_geojson["features"]:
            props = feat.get("properties", {})
            edge_id = props.get("edge_id")
            
            if edge_id is None:
                continue
                
            try:
                eid_int = int(float(edge_id))
                risk_score = edge_risk_map.get(eid_int, 0.0)
                
                # Classification of hazard levels
                if risk_score < 0.2055:
                    risk_level = "low"
                    color = "#FFF9C4"  
                
                elif risk_score < 0.3349:
                    risk_level = "medium"
                    color = "#FFC107"  
                
                elif risk_score < 0.4282:
                    risk_level = "high"
                    color = "#FF9800"  
                
                else:
                    risk_level = "very_high"
                    color = "#F44336"

                
                # Copy the feature and add risk attributes
                new_feat = {
                    "type": "Feature",
                    "geometry": feat["geometry"],
                    "properties": {
                        "edge_id": eid_int,
                        "risk_score": risk_score,
                        "risk_level": risk_level,
                        "color": color
                    }
                }
                features.append(new_feat)
                
            except (ValueError, TypeError):
                continue
        
        heatmap_geojson = {
            "type": "FeatureCollection",
            "features": features
        }
        
        print(f"[INFO] Returning {len(features)} edges for heatmap")
        return jsonify(heatmap_geojson)
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
        
if __name__ == "__main__":
    # debug=True makes it convenient to view errors during development. port=5001
    app.run(host="0.0.0.0", port=5001, debug=True)