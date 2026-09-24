---
name: spatial-awareness-cad
description: Spatial reasoning and geometric verification protocols for CAD operations. Teaches coordinate interpretation, bounding box analysis, extrusion direction prediction, and pre/post operation verification. Designed to prevent geometry placement errors.
version: 1.2.0
model_target: claude-opus-4-5
companion_skills: 
  - SKILL_Fusion360_Opus_v4.0.md
last_updated: 2024-12-09
---

# Spatial Awareness & Geometric Verification Skill v1.1

## Preamble: Why This Skill Exists

This skill addresses a critical gap in AI-assisted CAD: **spatial reasoning verification**. 
The Fusion 360 MCP skill teaches tool syntax; this skill teaches how to VERIFY that geometry 
will land where intended BEFORE executing operations.

**Core Principle**: Never assume spatial relationships—verify them programmatically.

**Load this skill WITH the Fusion360 skill for any CAD work.**

---

## Section 1: Coordinate System Quick Reference

### 1.1 Axis Definitions (Fusion 360 MCP)

```
                    +Z (Up/Height)
                     |
                     |
                     |_______ +X (Right/Width)
                    /
                   /
                  +Y (Toward Viewer/Depth)
```

| Axis | Positive Direction | Common Usage |
|------|-------------------|--------------|
| X | Right | Width dimension |
| Y | Toward viewer | Depth dimension |
| Z | Up | Height dimension |

### 1.2 Plane-to-World Coordinate Mapping (EMPIRICALLY VERIFIED)

⚠️ **CRITICAL: Z-AXIS NEGATION RULE** ⚠️

When Z is part of the sketch plane (XZ or YZ), the sketch coordinate that maps to World Z is **NEGATED**.

| Plane | Sketch X → | Sketch Y → | Extrude + → | Extrude - → | Z Negated? |
|-------|------------|------------|-------------|-------------|------------|
| **XY** | World X | World Y | +Z (up) | -Z (down) | N/A |
| **XZ** | World X | **World -Z** | +Y (toward) | -Y (away) | **YES** |
| **YZ** | **World -Z** | World Y | +X (right) | -X (left) | **YES** |

### 1.3 Practical Coordinate Calculation

**For XY Plane (no negation):**
```
Want World X from A to B → Sketch x1=A, x2=B
Want World Y from A to B → Sketch y1=A, y2=B
```

**For XZ Plane (Y maps to -Z):**
```
Want World X from A to B → Sketch x1=A, x2=B
Want World Z from A to B → Sketch y1=-B, y2=-A  ← NEGATE AND SWAP
```

**For YZ Plane (X maps to -Z):**
```
Want World Z from A to B → Sketch x1=-B, x2=-A  ← NEGATE AND SWAP
Want World Y from A to B → Sketch y1=A, y2=B
```

### 1.4 Examples

**Example 1: Bump centered at Z=1 on XZ plane**
- Want World Z: 0.5 to 1.5
- Sketch Y = -World Z
- Sketch y1 = -1.5, y2 = -0.5

**Example 2: Bump centered at Z=1 on YZ plane**
- Want World Z: 0.5 to 1.5
- Sketch X = -World Z
- Sketch x1 = -1.5, x2 = -0.5

**Example 3: Bump on XY plane at Z=5**
- Use offset=5 to place sketch at Z=5
- Sketch X and Y map directly (no negation)
- Extrude +distance goes up (+Z), -distance goes down (-Z)

### 1.5 Offset Plane Interpretation

When using `create_sketch(plane, offset)`:

| Plane | offset=5 places sketch at | offset=-3 places sketch at |
|-------|---------------------------|----------------------------|
| XY | Z = 5 | Z = -3 |
| XZ | Y = 5 | Y = -3 |
| YZ | X = 5 | X = -3 |

---

## Section 2: Bounding Box Interpretation

### 2.1 Reading Bounding Box Data

When `measure(type="body")` returns:
```json
{
  "bounding_box": {
    "min": {"x": -4.25, "y": -8.52, "z": 0.0},
    "max": {"x": 4.25, "y": 8.52, "z": 1.375}
  }
}
```

**Interpretation:**
- Body extends from X = -4.25 to X = +4.25 (centered on origin, width = 8.5)
- Body extends from Y = -8.52 to Y = +8.52 (centered on origin, depth = 17.04)
- Body extends from Z = 0 to Z = 1.375 (sitting on XY plane, height = 1.375)

### 2.2 Surface Location Identification

| To find this surface... | Look at... | The surface is at... |
|-------------------------|------------|----------------------|
| Left side | bounding_box.min.x | X = min.x |
| Right side | bounding_box.max.x | X = max.x |
| Back (away from viewer) | bounding_box.min.y | Y = min.y |
| Front (toward viewer) | bounding_box.max.y | Y = max.y |
| Bottom | bounding_box.min.z | Z = min.z |
| Top | bounding_box.max.z | Z = max.z |

### 2.3 Determining "Inside" vs "Outside"

For a HOLLOW body (like a phone case shell):
- **Outside/Exterior**: At the bounding box min/max values
- **Inside/Interior**: Between exterior and (exterior ± wall_thickness)

Example for a case with 0.3cm walls:
```
Exterior right surface: X = +4.25
Interior right surface: X = +4.25 - 0.3 = +3.95
```

---

## Section 3: Pre-Operation Verification Protocol

### 3.1 Before EVERY Geometry Operation

**STOP and complete this checklist BEFORE calling any geometry tool:**

```
□ Step 1: STATE THE INTENT
  - What am I trying to create?
  - Where should the NEW material exist in space?
  - What are the X, Y, Z coordinates of the new geometry's bounds?

□ Step 2: QUERY EXISTING GEOMETRY
  - Call measure(type="body") or get_body_info()
  - Identify relevant surfaces from bounding box
  - Note wall thickness if operating on shelled body

□ Step 3: PLAN THE OPERATION
  - Which plane will the sketch be on?
  - What offset is needed to place sketch at correct location?
  - Which direction will extrusion go (+ or -)?
  - What distance is needed?
  - ⚠️ APPLY Z-NEGATION RULE if using XZ or YZ plane!

□ Step 4: PREDICT THE RESULT
  - Calculate expected new bounding box min/max
  - Verify new geometry will be WHERE INTENDED
  - Verify new geometry will INTERSECT target body (if joining/cutting)

□ Step 5: EXECUTE AND VERIFY
  - Run the operation
  - Call measure() to verify actual vs predicted bounds
  - Request visual verification if uncertain
```

### 3.2 Sketch Coordinate Calculation Checklist

**For XY Plane:**
```
□ Sketch x1, x2 = World X values (direct)
□ Sketch y1, y2 = World Y values (direct)
□ Offset = World Z position of sketch
```

**For XZ Plane:**
```
□ Sketch x1, x2 = World X values (direct)
□ Sketch y1, y2 = NEGATE World Z values and SWAP order
  → Want Z from A to B? Use y1=-B, y2=-A
□ Offset = World Y position of sketch
```

**For YZ Plane:**
```
□ Sketch x1, x2 = NEGATE World Z values and SWAP order
  → Want Z from A to B? Use x1=-B, x2=-A
□ Sketch y1, y2 = World Y values (direct)
□ Offset = World X position of sketch
```

### 3.3 Extrusion Direction Verification

**Before extrude():**

1. Note the sketch plane (determines extrusion axis)
2. Determine if material should go in + or - direction
3. Calculate endpoint: `sketch_offset + (sign × distance)`
4. Verify: "Extruding [DISTANCE] will create material from [START] to [END] on [AXIS]"

| Plane | Extrude + | Extrude - |
|-------|-----------|-----------|
| XY | +Z (up) | -Z (down) |
| XZ | +Y (toward viewer) | -Y (away from viewer) |
| YZ | +X (right) | -X (left) |

---

## Section 4: Error Case Library

### 4.1 Error Case 001: Grip Ridges in Empty Space

**Date**: 2024-12-09
**Operation**: Add grip ridges to side of phone case

**What I Did**:
- Sketch plane: YZ at offset X = 4.25 (right side of case)
- Sketch geometry: Three rectangles for ridges
- Extrusion: distance = 0.15 (positive, meaning +X direction)

**What I Expected**:
- Ridges would appear on the right side of the case

**What Actually Happened**:
- Ridges extruded in +X direction, AWAY from the case into empty space
- Ridges are floating 0.15cm to the right of the case, not attached

**Root Cause**:
- Sketch was placed AT the outer surface (X = 4.25)
- Positive extrusion went +X (further right, away from case)
- Ridges were created but not intersecting the case body

**Generalizable Lesson**:
- Before extruding, ask: "Will the extruded material INTERSECT my target body?"
- For features protruding from a surface: sketch ON surface, extrude AWAY from body center
- Verify the extrusion creates geometry that touches/intersects existing bodies

### 4.2 Error Case 002: Z-Axis Negation Discovery

**Date**: 2024-12-09
**Operation**: Add bump to right side (+X face) of calibration block

**What I Did (First Attempt)**:
- Sketch plane: YZ at offset X = 2
- Rectangle: x1=-0.5, x2=0.5, y1=0.5, y2=1.5
- Expected World coords: Y=-0.5 to 0.5, Z=0.5 to 1.5

**What Actually Happened**:
- Got: Y=0.5 to 1.5, Z=-0.5 to 0.5
- The Y and Z were swapped AND Z was in wrong location

**What I Did (Second Attempt)**:
- Hypothesized: Sketch X → World Z, Sketch Y → World Y
- Rectangle: x1=0.5, x2=1.5, y1=-0.5, y2=0.5
- Expected World Z: 0.5 to 1.5

**What Actually Happened**:
- Got World Z: -1.5 to -0.5
- Z was NEGATED!

**What I Did (Third Attempt)**:
- Applied negation: x1=-1.5, x2=-0.5 (to get World Z 0.5 to 1.5)
- SUCCESS!

**Root Cause**:
- YZ plane: Sketch X maps to **negative** World Z
- This is NOT documented in standard references
- Same pattern found on XZ plane (Sketch Y → negative World Z)

**Generalizable Lesson**:
- **Z-NEGATION RULE**: When Z is part of sketch plane, the sketch coordinate mapping to Z is NEGATED
- XZ plane: Sketch Y = -World Z
- YZ plane: Sketch X = -World Z
- To get World Z from A to B, use sketch coord from -B to -A

### 4.3 Error Case 003: XZ Plane Z-Negation Confirmation

**Date**: 2024-12-09
**Operation**: Add bump to back face (-Y) of calibration block

**What I Did (First Attempt)**:
- Sketch plane: XZ at offset Y = -2
- Rectangle: x1=-0.5, x2=0.5, y1=0.5, y2=1.5
- Expected World Z: 0.5 to 1.5

**What Actually Happened**:
- Got World Z: -1.5 to -0.5
- Confirmed: XZ plane also has Z negation!

**What I Did (Corrected)**:
- Applied negation: y1=-1.5, y2=-0.5
- SUCCESS!

**Generalizable Lesson**:
- Z-negation rule applies to BOTH XZ and YZ planes
- Only XY plane has direct mapping (Z is extrusion axis, not in sketch)

---


### 4.4 Error Case 004: Face Index Instability After Geometry Operations

**Date**: 2024-12-09
**Operation**: Shell a filleted body

**What I Did**:
- Created solid block, extruded on XY plane
- Applied fillet to 4 vertical corner edges
- Queried faces BEFORE fillet: Top face was index 4
- Attempted shell with faces_to_remove=[4]

**What Actually Happened**:
- Shell removed the WRONG face (middle of body)
- Created two disconnected pieces instead of hollow case
- The face that WAS index 4 before filleting was NO LONGER index 4 after filleting

**Root Cause**:
- Fillet operation added 4 new curved faces (one per corner)
- This shifted all face indices
- Original face 4 (top) became face 2 after filleting
- I used stale index data

**What I Should Have Done**:
- Re-query get_body_info() AFTER the fillet operation
- Find the top face by centroid.z = max height, not by remembered index
- Never trust face/edge indices across geometry-modifying operations

**Generalizable Lesson**:
- **INDEX INSTABILITY RULE**: Face and edge indices change after ANY geometry-modifying operation
- After fillet, chamfer, shell, extrude, or any feature: RE-QUERY indices
- Identify faces/edges by GEOMETRY (centroid, area, length) not by index memory
- To find top face: look for face with centroid.z = body max.z
- To find bottom face: look for face with centroid.z = body min.z
- To find side faces: look for faces with centroid at x/y extremes

**Identification Strategy**:
```
To find TOP face after modifications:
1. Call get_body_info()
2. Find face where centroid.z equals bounding_box.max.z
3. Use THAT index for shell/other operations

To find BOTTOM face:
1. Find face where centroid.z equals bounding_box.min.z

To find SIDE faces:
1. Find faces where centroid.x or centroid.y equals bounding box extremes
```

---

## Section 5: Post-Operation Verification Checklist

### 5.1 After Every Geometry Operation

```
□ Call measure(type="body") on the affected body
□ Compare actual bounding box to predicted bounding box
□ Verify:
  - min.x, max.x match expected X bounds (±0.001 tolerance)
  - min.y, max.y match expected Y bounds (±0.001 tolerance)  
  - min.z, max.z match expected Z bounds (±0.001 tolerance)
□ If multiple bodies exist, verify correct body was modified
□ Check body count - did operation create new body or modify existing?
□ For assemblies: call check_interference()
□ If ANY verification fails: STOP and diagnose before proceeding
```

---

## Section 6: Quick Reference Cards

### 6.1 "Sketch Coordinate Calculator" Card

```
STEP 1: Identify target World coordinates
  World X: Xa to Xb
  World Y: Ya to Yb
  World Z: Za to Zb

STEP 2: Choose plane based on which surface you're working on
  - Top/Bottom (horizontal) → XY plane
  - Front/Back → XZ plane
  - Left/Right → YZ plane

STEP 3: Calculate sketch coordinates

  XY PLANE (offset = Z position):
    x1=Xa, x2=Xb, y1=Ya, y2=Yb

  XZ PLANE (offset = Y position):
    x1=Xa, x2=Xb, y1=-Zb, y2=-Za  ← Z NEGATED

  YZ PLANE (offset = X position):
    x1=-Zb, x2=-Za, y1=Ya, y2=Yb  ← Z NEGATED
```

### 6.2 "Extrusion Direction" Card

```
XY plane, extrude +D → material goes UP (toward +Z)
XY plane, extrude -D → material goes DOWN (toward -Z)

XZ plane, extrude +D → material goes TOWARD viewer (+Y)
XZ plane, extrude -D → material goes AWAY from viewer (-Y)

YZ plane, extrude +D → material goes RIGHT (+X)
YZ plane, extrude -D → material goes LEFT (-X)
```

### 6.3 "Sanity Check Questions" Card

Before executing, ask yourself:
1. "Did I apply Z-negation if using XZ or YZ plane?"
2. "If I extrude [DISTANCE] in [DIRECTION], where does the material END UP?"
3. "Does that endpoint make sense for what I'm trying to create?"
4. "Will the new geometry TOUCH the existing body?"

---

## Document Metadata

```yaml
skill_name: spatial-awareness-cad
version: 1.2.0
target_model: claude-opus-4-5
companion_skills:
  - SKILL_Fusion360_Opus_v4.0.md
created: 2024-12-09
last_updated: 2024-12-09
error_cases_documented: 4
training_status: CALIBRATED - Z-negation rule verified
changelog:
  v1.2.0: Added Error Case 004 (face index instability), added INDEX INSTABILITY RULE
  v1.1.0: Added Z-negation rule (empirically verified), updated coordinate mapping tables, added error cases 002 and 003
  v1.0.0: Initial release
```

---

*End of Spatial Awareness & Geometric Verification Skill v1.1*

