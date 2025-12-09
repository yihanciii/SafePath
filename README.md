# SafePath — Crime-Aware Routing System

A Manhattan-focused routing engine that improves walking safety by leveraging
real-time crime, crash, and CCTV dataset integration.

This project is built for academic purposes to demonstrate practical use of:
- Spatial ETL & feature engineering
- Geospatial network modeling using OSMnx & NetworkX
- Crime risk scoring based on multi-source data
- Routing optimization for safer navigation
- PostGIS + MongoDB geolocation database design

---

## Project Features

| Component | Description |
|----------|-------------|
| Data Cleaning | Normalize coordinates, remove invalid records, keep Manhattan-only samples over recent 3 years |
| Street Graph | Road network built from OSM (walkable edges) |
| Risk Modeling | Calculate weighted risk score using crime, crashes, missing CCTV |
| Routing API | Flask API returning safest path using risk-weighted Dijkstra |
| User Reports | MongoDB storing community-reported incidents |

---

## Project Structure
SafePath/  
├─ app.py # Flask Backend API  
├─ route_engine.py # NetworkX routing engine  
├─ index.html # UI (map visualization)  
├─ map.js # Frontend logic  
├─ data/ # (sample data only) CSV, GeoJSON  
├─ notebooks/ # Jupyter notebooks for ETL  
└─ README.md  

> Full raw datasets excluded due to file size.
> Only small samples included for reproducibility in GitHub.

---

## Dependencies
Flask  
Flask-Cors  
NetworkX  
NumPy  
Pandas  
SciPy  
pymongo  
osmnx  
geopandas  

---

## SafePath Demo

### Generating Route
![](assets/demo1.gif)

### Show the Heatmap
![](assets/demo2.gif)

### User Report
![](assets/demo3.gif)

## How to Run

Backend:
```bash
python app.py
```
Frontend:  
Open index.html in browser

