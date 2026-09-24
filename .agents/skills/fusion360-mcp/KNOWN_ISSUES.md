# Known Issues and Solutions

Common pitfalls when using the Fusion 360 MCP, and how to avoid them.

---

## 1. Unit Confusion (Most Common!)

### Problem
All MCP dimensions are in **centimeters**, but users often think in millimeters.

### Symptoms
- Parts are 10x too large or too small
- A "50mm box" becomes half a meter

### Solution
**Always convert:** `mm ÃƒÂ· 10 = cm`

| User Says | You Enter |
|-----------|-----------|
| 50 mm | `5.0` |
| 100 mm | `10.0` |
| 25.4 mm (1 inch) | `2.54` |

**Red flag:** Any dimension > 50 is probably wrong (that's half a meter!).

---

## 2. Extrusion Direction

### Problem
Extrusions go the wrong way (into the part instead of out, or vice versa).

### The Rules
From the **front view** (looking at origin from +Y):

| Sketch Plane | Positive Extrusion | Negative Extrusion |
|--------------|-------------------|-------------------|
| XY plane | +Z (up) | -Z (down) |
| XZ plane | +Y (toward you) | -Y (away) |
| YZ plane | +X (right) | -X (left) |

### Solution
Always visualize which way the normal points before extruding.

---

## 3. Component Positioning

### Problem
Components appear at origin instead of intended position, or overlap.

### Key Concepts
- **Stacking** = Same X,Y, different Z (parts on top of each other)
- **Spreading** = Different X,Y (parts side by side)

### Solution
1. **Always call `list_components()`** before positioning
2. Use `move_component()` after creation
3. Verify with `get_design_info()` to check positions

---

## 4. Save vs Export

### Problem
User asks to "save" but Claude exports a STEP file. Design is lost when Fusion closes.

### Key Distinction
| Action | What Happens |
|--------|--------------|
| **Save** | Persists .f3d to Fusion cloud |
| **Export** | Creates external file (STL, STEP) |

**Export Ã¢â€°Â  Save.** They are completely different operations.

### Solution
The MCP currently lacks a save command. When user says "save":
1. Inform them the MCP cannot save directly
2. Ask them to manually save (Ctrl+S or File Ã¢â€ â€™ Save)
3. Wait for confirmation
4. Then export if requested

---

## 5. Blade/Edge Bevels

### Problem
Trying to create beveled edges on thin parts using boolean cuts (fails or creates bad geometry).

### Solution
Use **chamfer**, not boolean operations:
```
chamfer(edges=[...], distance=thickness/2)
```

For knife/blade edges, chamfer distance should be approximately half the material thickness.

---

## 6. Component Deletion

### Problem
Deleting a component causes index shifts, breaking subsequent operations.

### Solution
1. **Delete in reverse order** (highest index first)
2. Or delete by name, not index
3. Always re-query `list_components()` after any deletion

---

## 7. Fastener Holes

### Problem
Holes for fasteners are wrong size or position.

### Solution
Standard clearance holes (mm Ã¢â€ â€™ cm for MCP):

| Fastener | Clearance Hole | Enter in MCP |
|----------|---------------|--------------|
| M3 | 3.4 mm | `0.34` |
| M4 | 4.5 mm | `0.45` |
| M5 | 5.5 mm | `0.55` |
| #6 | 4.0 mm | `0.40` |
| 1/4" | 7.0 mm | `0.70` |

---

## 8. Mating Parts / Interference

### Problem
Parts that should fit together either collide or have gaps.

### Solution
1. Design with **clearances** (0.2-0.5mm for 3D printing)
2. Use `measure()` to verify distances
3. Check interference with `get_body_info()` before combining

---

## 9. Session State Mismatch

### Problem
Claude assumes prior work exists, but Fusion crashed/recovered to earlier state.

### Solution
**At session start, always:**
1. Call `get_design_info()` to verify current state
2. Check body count matches expectations
3. Don't assume anything from previous sessions

---

## 10. Batch Operations

### Problem
Many small operations are slow (each has ~50ms roundtrip).

### Solution
Use `batch_operations()` for multiple related commands:
```python
batch_operations([
    {"tool": "draw_rectangle", "params": {...}},
    {"tool": "draw_circle", "params": {...}},
    {"tool": "extrude", "params": {...}}
])
```

This is 5-10x faster than individual calls.

---



---

## 11. XZ Plane Y-Axis Inversion (CONFIRMED - BY DESIGN)

### Problem
When drawing geometry on the XZ plane with `center_y=0.3`, the resulting geometry appears at World Z=-0.3 instead of Z=0.3. The Y-axis is **inverted** relative to World Z.

### Root Cause (Confirmed by Autodesk Engineering)

This is **intentional behavior**, not a bug. The XZ plane has inverted Y because of two competing requirements:

**Requirement 1:** Positive extrusion on XZ plane must go toward +Y (into the model)
**Requirement 2:** All Fusion coordinate systems must be right-handed

To satisfy BOTH requirements, Sketch Y must map to -World Z.

```
XZ Plane Coordinate Mapping:
  Sketch X  â†’  World X   (unchanged)
  Sketch Y  â†’  World -Z  (INVERTED!)
  Extrude+  â†’  World +Y  (as expected)
```

### Plane Comparison

| Plane | Sketch X | Sketch Y | Normal (Extrude+) | Natural? |
|-------|----------|----------|-------------------|----------|
| XY | World +X | World +Y | World +Z | âœ“ Yes |
| YZ | World +Y | World +Z | World +X | âœ“ Yes |
| **XZ** | World +X | **World -Z** | World +Y | âœ— **INVERTED** |

### Solution: Negate Y for Z Positioning

```python
# To place geometry at World Z = target_z on XZ plane:
sketch_y = -target_z  # NEGATE!

# Example: Center at World Z = +0.3
draw_polygon(center_x=0, center_y=-0.3, ...)  # Use -0.3!

# Example: Center at World Z = -1.0
draw_circle(center_x=0, center_y=1.0, ...)    # Use +1.0!
```

### Quick Reference

| Target World Z | Use center_y = |
|----------------|----------------|
| +2.0 | -2.0 |
| +0.3 | -0.3 |
| 0 | 0 |
| -0.5 | +0.5 |
| -2.0 | +2.0 |

**Formula: `center_y = -target_world_z`**

### Alternative: Use XY Plane Instead

```python
# Avoid XZ plane entirely for Z-critical positioning:
create_sketch(plane="XY", offset=target_z)
draw_polygon(center_x=0, center_y=y_position, ...)
extrude(distance=thickness)  # Goes +Z, no inversion
```

### Source

Autodesk Engineering Director Jeff Strater confirmed this is by design:
- Thread: https://forums.autodesk.com/t5/fusion-support-forum/sketch-on-xz-plane-shows-z-positive-downwards-left-handed-coord/td-p/11675127
- Detailed explanation: https://forums.autodesk.com/t5/fusion-design-validate-document/why-is-my-sketch-text-appearing-upside-down/m-p/6645704

---

## 12. Auto-Join Without User Verification

### Problem
Claude automatically joins newly created bodies to the main model without asking for user verification first. If the geometry is wrong, it's now permanently merged and requires manual undo.

### Why This Happens
- Trying to be "efficient" by combining steps
- Overconfidence that geometry is correct
- Ignoring documented join protocol

### Impact
- Wrong geometry gets baked into model
- User must manually undo (Ctrl+Z) multiple operations
- Time wasted, trust eroded

### Solution: ALWAYS Verify Before Join

```python
# 1. Create geometry as separate body
extrude(...)  # Creates NEW body

# 2. Confirm body exists
get_design_info()  # Check body_count

# 3. ASK USER - DO NOT SKIP THIS
# "Created [part] as separate body. Please verify position/shape."
# "Confirm to join?"

# 4. Wait for explicit "yes" before:
combine(operation="join", ...)
```

### Hard Rule
**NEVER call combine() without explicit user approval.** The 10 seconds saved by auto-joining can cost 10 minutes of cleanup when something is wrong.

---
*Document current as of MCP v8.2*