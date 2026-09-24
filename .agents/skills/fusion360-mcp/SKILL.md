---
name: fusion360-mcp
description: Fusion 360 MCP CAD operations guide for Claude Opus. Comprehensive reference for 3D modeling, assemblies, manufacturing design, and parametric CAD automation. Includes coordinate system rules, assembly positioning workflows, API patterns, and DFM guidelines.
version: 1.0.0
model_target: any-claude-model
mcp_version: 7.0.0
---

# Fusion 360 MCP Skill Guide for Claude Opus v4.6

## Preamble: Your Role as CAD Assistant

You are assisting users with professional CAD modeling through the Fusion 360 MCP interface. This skill file provides comprehensive guidance for creating accurate, manufacturable, and well-organized 3D models. As Opus, you have the reasoning capacity to handle complex multi-component assemblies, optimize designs for manufacturing, and troubleshoot geometric issues.

**Your Responsibilities**:
1. Create accurate 3D geometry matching user specifications
2. Ensure designs are manufacturable for the intended process
3. Verify all component positions and detect interference
4. Provide clear explanations of design decisions
5. Anticipate potential issues before they occur

**MCP v7.0 Capabilities**:
- Component positioning with `move_component` and `rotate_component`
- Hollow part creation with `shell`
- Selective edge treatment with enhanced `fillet`/`chamfer`
- Manufacturing features: `draft`, `pattern_rectangular`, `pattern_circular`, `mirror`
- Inspection tools: `get_body_info`, `measure`
- Offset sketch planes via `create_sketch(offset=...)`

---


---

## Section 0: Session Initialization Protocol (CRITICAL)

### 0.1 Vision-First Verification

**MANDATORY ON EVERY SESSION START:**

Before executing ANY Fusion 360 MCP commands, Claude MUST:

1. **Use Vision** to visually inspect the current Fusion 360 state
2. **Verify design continuity** - the drawing may not have saved where you left off
3. **Check what actually exists** before assuming prior work is intact

```
PROTOCOL:
1. Call State-Tool with use_vision=true
2. Visually analyze:
   - Is the expected design file open?
   - What bodies/features are visible?
   - Does the timeline show expected operations?
   - Are there any error indicators?
3. Call get_design_info() to confirm programmatically
4. Compare visual vs programmatic state
5. Only then proceed with operations
```

### 0.2 Why This Matters

**Common State Mismatches:**
- Fusion 360 may have crashed and recovered to earlier state
- User may have undone operations after Claude's session ended
- Auto-save may not have captured all changes
- Design may have been edited manually between sessions

**The Cost of Skipping:**
- Operations on non-existent bodies ? errors
- Wrong body indices ? corrupted geometry
- Wasted time debugging phantom issues

### 0.3 Session Start Checklist

```
? Vision check completed
? Design file name matches expected
? Body count matches expected
? Key features visually confirmed
? Timeline length reasonable for work done
? No error dialogs or warnings visible
? get_design_info() matches visual observation
```

**Only proceed with CAD operations after ALL checks pass.**


## Section 1: Coordinate System Mastery

### 1.1 The Global Coordinate System (MEMORIZE THIS)

Fusion 360 MCP uses a right-handed coordinate system. From the **FRONT VIEW** (looking at the origin from positive Y):

```
                    +Z (Vertical/Up)
                     |
                     |
                     |
                     +------------ +X (Horizontal/Right)
                    /
                   /
                  /
                +Y (Depth/Toward Viewer)
```

| Axis | Physical Meaning | Positive Direction | Sketch Plane Usage |
|------|------------------|--------------------|--------------------|
| **X** | Width | Right | Horizontal in XY and XZ |
| **Y** | Depth | Toward viewer | Vertical in YZ, Horizontal in XY |
| **Z** | Height | Up | Vertical in XZ and YZ |

### 1.2 Construction Plane Deep Dive

Understanding plane selection is CRITICAL for correct geometry:

#### XY Plane (Horizontal/Ground Plane)
```
        +Y (depth)
         |
         |
         +-------- +X (width)
        
Extrusion: +Z (up) or -Z (down)
```
**Use For**: Floor plans, base plates, horizontal surfaces, table tops, PCB layouts.

#### XZ Plane (Vertical/Front Wall)
```
        +Z (height)
         |
         |
         +-------- +X (width)
        
Extrusion: +Y (toward you) or -Y (away)
```
**Use For**: Vertical panels, wall-mounted items, facades, elevation views.

#### YZ Plane (Vertical/Side Wall)
```
        +Z (height)
         |
         |
         +-------- +Y (depth)
        
Extrusion: +X (right) or -X (left)
```
**Use For**: Side profiles, cross-sections, lateral features.

### 1.3 Sketch-to-World Coordinate Mapping (EMPIRICALLY VERIFIED)

**CRITICAL: Z-AXIS NEGATION RULE**
When Z is part of the sketch plane (XZ or YZ), the sketch coordinate that maps to World Z is **NEGATED**.

| Sketch On | Sketch X -> World | Sketch Y -> World | Extrusion -> World | Z Negated? |
|-----------|-------------------|-------------------|--------------------| -----------|
| XY Plane | X (direct) | Y (direct) | +/-Z | N/A |
| XZ Plane | X (direct) | **-Z (negated)** | +/-Y | **YES** |
| YZ Plane | **-Z (negated)** | Y (direct) | +/-X | **YES** |

**Practical Application:**
- XY plane: x1,x2 -> World X; y1,y2 -> World Y (direct mapping)
- XZ plane: x1,x2 -> World X; y1,y2 -> -World Z (to get Z from A to B, use y1=-B, y2=-A)
- YZ plane: x1,x2 -> -World Z (to get Z from A to B, use x1=-B, x2=-A); y1,y2 -> World Y

---

## Section 1.4: MCP Tool Limitations (CRITICAL)

### 1.4.1 Missing Boolean Operations

The Fusion 360 MCP currently **DOES NOT SUPPORT** boolean operations:
- **No Cut operation**: Cannot subtract one body from another
- **No Join operation**: Cannot merge bodies together  
- **No Intersect operation**: Cannot create intersection of bodies

**Impact**: The `extrude()` function ALWAYS creates a NEW BODY. It cannot:
- Cut holes in existing bodies
- Add material to existing bodies
- Perform any combine operations

**Workaround**: User must manually perform Modify > Combine in Fusion 360 UI after Claude creates the tool body.

### 1.4.2 Workflow for Creating Cutouts

Since boolean cut is not available, use this workflow:

1. **Create the main body** (e.g., phone case shell)
2. **Create tool bodies** for each cutout (camera hole, button slots, port openings)
3. **Inform user** which bodies need to be combined/cut
4. **User performs** Modify > Combine manually:
   - Target Body: Main body
   - Tool Bodies: Cutout bodies
   - Operation: Cut
   - Keep Tools: No (usually)

### 1.4.3 Requested MCP Enhancements

The following functions are needed but not yet implemented:

| Function | Purpose | Parameters Needed |
|----------|---------|-------------------|
| `combine()` | Boolean operations | target_body, tool_body, operation (cut/join/intersect), keep_tools |
| `extrude_cut()` | Extrude and subtract | Same as extrude, plus target_body |
| `extrude_join()` | Extrude and add | Same as extrude, plus target_body |

See: `MCP_ENHANCEMENT_REQUEST_Fusion360.md` for full specification.

### 1.4.4 Face/Edge Index Instability

**CRITICAL**: Face and edge indices are NOT stable across operations.

After ANY geometry-modifying operation (fillet, chamfer, shell, extrude, etc.):
- Face indices WILL change
- Edge indices WILL change
- Previously queried indices are INVALID

**Required Protocol**:
1. Perform geometry operation
2. **IMMEDIATELY** call `get_body_info()` to get NEW indices
3. Identify faces/edges by GEOMETRY (centroid position, area, length), not by memorized index
4. Use fresh indices for next operation

**Example - Finding Top Face After Modifications**:
```
1. Call get_body_info(body_index=0)
2. Look at faces array
3. Find face where centroid.z == bounding_box.max.z
4. Use THAT face index for shell or other operations
```

### 1.4 Origin Behavior and Offset Planes (NEW in v7.0)

**Fundamental Rule**: All sketches are created at the world origin by default.

**NEW: Offset Planes**: MCP v7.0 supports creating sketches on offset planes:

```python
# Sketch 5cm above origin
create_sketch(plane="XY", offset=5)
draw_rectangle(x1=-5, y1=-5, x2=5, y2=5)
finish_sketch()
extrude(distance=2)  # Creates geometry from Z=5 to Z=7
```

This eliminates the need for complex sketch positioning workarounds!


### 1.5 Utility Operations (v8.2)

The MCP now includes utility operations for cleanup and iteration:

#### undo(count=1)
Undo recent operations in Fusion 360.

```python
undo()           # Undo last operation
undo(count=5)    # Undo last 5 operations
undo(count=20)   # Undo up to 20 operations
```

**Returns:** `{"undone_count": 5, "requested_count": 5}`

**Use Cases:**
- Revert failed operations
- Clean up after experimentation
- Reset to known good state

#### delete_body(body_index=None)
Delete a specific body by index.

```python
delete_body()              # Delete most recent body
delete_body(body_index=3)  # Delete body at index 3
```

**Returns:** `{"deleted_body": "Body5", "deleted_index": 3, "remaining_bodies": 4}`

**Important:** After deleting a body, remaining body indices shift down!

#### delete_sketch(sketch_index=None)
Delete a specific sketch by index.

```python
delete_sketch()                # Delete most recent sketch
delete_sketch(sketch_index=2)  # Delete sketch at index 2
```

**Returns:** `{"deleted_sketch": "Sketch3", "deleted_index": 2, "remaining_sketches": 4}`

#### Cleanup Workflow Example

```python
# Created 5 tool bodies but design is wrong
get_design_info()  # Shows body_count: 6

# Delete unwanted bodies (work backwards to avoid index shifting)
delete_body(body_index=5)
delete_body(body_index=4)
delete_body(body_index=3)
delete_body(body_index=2)
delete_body(body_index=1)

# Or just undo all the extrusions
undo(count=5)
```


---


### 1.6 Join Protocol (CRITICAL - USER REQUESTED)

**RULE: Joining should be the FINAL step. Always verify with user before combining bodies.**

**Why This Matters:**
- Once joined, individual parts cannot be easily edited
- Errors caught before joining are easy to fix
- Errors caught after joining require undo/rebuild

**Protocol:**
1. Create all parts as separate bodies
2. Position and verify each part visually
3. **ASK USER** to confirm before any join/combine operation
4. Only after user approval: execute combine(operation="join")

**Example Workflow:**
```python
# Create blade, crossguard, grip, pommel as separate bodies
# ... modeling operations ...

get_design_info()  # Show body count
# "You should now have 4 bodies: blade, crossguard, grip, pommel"
# "Please verify alignment. Ready to join?"

# WAIT FOR USER CONFIRMATION

# Only then:
combine(operation="join", target_body=0, tool_bodies=[1,2,3])
```

**Never auto-join** - always pause for user verification first.


## Section 2: Complete Tool Reference

### 2.1 Sketch Creation and Management

#### `create_sketch(plane, offset=0)` ÃƒÂ¢Ã…â€œÃ‚Â¨ ENHANCED
Initiates a new sketch on the specified construction plane.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `plane` | string | Yes | - | "XY", "XZ", or "YZ" |
| `offset` | number | No | 0 | Offset distance from origin (cm) |

**NEW: Offset Capability**:
```python
# Create sketch at different heights
create_sketch(plane="XY", offset=0)    # At Z=0
create_sketch(plane="XY", offset=5)    # At Z=5
create_sketch(plane="XY", offset=-3)   # At Z=-3

# Stacking without overlap
create_sketch(plane="XY")
draw_rectangle(x1=-5, y1=-5, x2=5, y2=5)
finish_sketch()
extrude(distance=2)  # Z: 0ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢2
create_component(name="Base")

create_sketch(plane="XY", offset=2)  # Start where base ends!
draw_rectangle(x1=-4, y1=-4, x2=4, y2=4)
finish_sketch()
extrude(distance=3)  # Z: 2ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢5
create_component(name="Top")
```

#### `finish_sketch()`
Exits sketch edit mode. Required before any 3D operations.

### 2.2 Sketch Geometry Tools

#### `draw_rectangle(x1, y1, x2, y2)`
Creates a rectangle using two corner points (all values in cm).

**Centering Strategies**:
```python
# Centered at origin (RECOMMENDED)
width, height = 20, 10
draw_rectangle(x1=-width/2, y1=-height/2, x2=width/2, y2=height/2)

# Corner at origin
draw_rectangle(x1=0, y1=0, x2=width, y2=height)
```

#### `draw_circle(center_x, center_y, radius)`
Creates a circle (all values in cm).

#### `draw_line(x1, y1, x2, y2)`
Creates a straight line segment. Lines must form CLOSED loops for extrusion.

#### `draw_arc(center_x, center_y, start_x, start_y, end_x, end_y)`
Creates a circular arc. Start and end must be equidistant from center.


##### Arc Direction Control (CRITICAL)

The `draw_arc` function draws from start to end around the center point. **The direction of travel determines which way the arc curves.**

**Arc Direction Rule:**
- Arc travels **counterclockwise** from start to end (when viewed from +Z)
- Swapping start and end points **reverses the curvature direction**

**Example - Stadium/Obround Shape (for ergonomic handles):**

```python
# WRONG - arcs curve INWARD (concave):
draw_arc(start_x=-0.7, start_y=0.2, end_x=-0.7, end_y=-0.8, center_x=-0.7, center_y=-0.3)

# CORRECT - arcs curve OUTWARD (convex):
draw_arc(start_x=-0.7, start_y=-0.8, end_x=-0.7, end_y=0.2, center_x=-0.7, center_y=-0.3)
```

**Visual Guide:**
```
For a stadium shape (pill/obround):
    
    ___________
   (           )   <- Arc curves OUTWARD (correct)
   |           |
   |           |
   (___________) 

If arcs are inverted:
    ___________
   )           (   <- Arc curves INWARD (wrong!)
   |           |
```

**Key Insight:** If your closed shape looks "pinched" or the arcs go the wrong way, swap the start_x/start_y with end_x/end_y for each arc.

#### `draw_polygon(center_x, center_y, radius, sides=6)`
Creates a regular polygon (default: hexagon).

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `center_x` | number | Yes | - | Center X (cm) |
| `center_y` | number | Yes | - | Center Y (cm) |
| `radius` | number | Yes | - | Circumscribed radius (cm) |
| `sides` | integer | No | 6 | Number of sides (ÃƒÂ¢Ã¢â‚¬Â°Ã‚Â¥3) |

### 2.3 Feature Creation Tools

#### `extrude(distance, profile_index=0, taper_angle=0)` ÃƒÂ¢Ã…â€œÃ‚Â¨ ENHANCED
Extrudes the most recent sketch profile.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `distance` | number | Yes | - | Extrusion distance (cm) |
| `profile_index` | integer | No | 0 | Which profile to extrude |
| `taper_angle` | number | No | 0 | Draft angle during extrusion (degrees) |

**NEW: Taper During Extrusion**:
```python
# Create tapered extrusion (for draft)
create_sketch(plane="XY")
draw_rectangle(x1=-5, y1=-5, x2=5, y2=5)
finish_sketch()
extrude(distance=10, taper_angle=2)  # 2Ãƒâ€šÃ‚Â° taper for injection molding
```

#### `revolve(angle)`
Revolves profile around the sketch's Y-axis.

#### `fillet(radius, edges=None, body_index=None)` ÃƒÂ¢Ã…â€œÃ‚Â¨ ENHANCED
Applies rounded fillets to edges.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `radius` | number | Yes | - | Fillet radius (cm) |
| `edges` | list | No | None | Edge indices (None = all edges) |
| `body_index` | integer | No | Last | Which body to fillet |

**NEW: Selective Edge Filleting**:
```python
# Get edge information first
get_body_info()  # Returns edge indices

# Fillet only specific edges
fillet(radius=0.2, edges=[0, 1, 5, 6])  # Top edges only

# Fillet all edges (original behavior)
fillet(radius=0.2)
```

#### `chamfer(distance, edges=None, body_index=None)` ÃƒÂ¢Ã…â€œÃ‚Â¨ ENHANCED
Applies beveled chamfers to edges.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `distance` | number | Yes | - | Chamfer distance (cm) |
| `edges` | list | No | None | Edge indices (None = all edges) |
| `body_index` | integer | No | Last | Which body to chamfer |

**NEW: Selective Edge Chamfering**:
```python
# Chamfer only bottom edges
chamfer(distance=0.1, edges=[8, 9, 10, 11])
```

### 2.4 NEW: Shell, Draft, Patterns, and Mirror

#### `shell(thickness, faces_to_remove=None, body_index=None)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Creates a hollow shell from a solid body.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `thickness` | number | Yes | - | Wall thickness (cm) |
| `faces_to_remove` | list | No | None | Face indices to open |
| `body_index` | integer | No | Last | Which body to shell |

**Examples**:
```python
# Closed hollow shell (2mm walls)
shell(thickness=0.2)

# Open-top container
get_body_info()  # Find top face index (often face 0)
shell(thickness=0.15, faces_to_remove=[0])

# Box with two openings (top and front)
shell(thickness=0.2, faces_to_remove=[0, 2])
```

**Use Cases**:
- Enclosures and housings
- Containers and boxes
- Weight reduction
- Material savings

#### `draft(angle, faces=None, body_index=None, pull_x=0, pull_y=0, pull_z=1)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Applies draft angles for injection molding.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `angle` | number | Yes | - | Draft angle (degrees) |
| `faces` | list | No | None | Face indices to draft |
| `body_index` | integer | No | Last | Which body to draft |
| `pull_x/y/z` | number | No | 0,0,1 | Pull direction vector |

**Manufacturing Guideline**: 1Ãƒâ€šÃ‚Â° per inch of depth minimum.

```python
# Standard draft for injection molding
draft(angle=1.0)

# Draft specific vertical faces
get_body_info()  # Find vertical face indices
draft(angle=1.5, faces=[1, 2, 3, 4])
```

#### `pattern_rectangular(x_count, x_spacing, y_count=1, y_spacing=0, body_index=None)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Creates a rectangular (linear) pattern.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `x_count` | integer | Yes | - | Instances in X direction |
| `x_spacing` | number | Yes | - | Spacing in X (cm) |
| `y_count` | integer | No | 1 | Instances in Y direction |
| `y_spacing` | number | No | 0 | Spacing in Y (cm) |
| `body_index` | integer | No | Last | Which body to pattern |

**Examples**:
```python
# Linear array (1D)
pattern_rectangular(x_count=5, x_spacing=2)  # 5 instances, 2cm apart

# Grid array (2D)
pattern_rectangular(x_count=4, x_spacing=2.5, y_count=3, y_spacing=2.5)
# Creates 4ÃƒÆ’Ã¢â‚¬â€3 = 12 instances
```

**Use Cases**:
- Mounting hole arrays
- Heat sink fins
- Ventilation slots
- Repeated features

#### `pattern_circular(count, angle=360, axis="Z", body_index=None)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Creates a circular (radial) pattern.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `count` | integer | Yes | - | Number of instances |
| `angle` | number | No | 360 | Total angle (degrees) |
| `axis` | string | No | "Z" | Rotation axis: "X", "Y", or "Z" |
| `body_index` | integer | No | Last | Which body to pattern |

**Examples**:
```python
# Full circle of 6 instances
pattern_circular(count=6)

# Half circle of 4 instances
pattern_circular(count=4, angle=180)

# Around X-axis
pattern_circular(count=8, axis="X")
```

**Use Cases**:
- Bolt circles
- Radial fins
- Spoke patterns
- Decorative features

#### `mirror(plane="YZ", body_index=None)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Creates a mirrored copy of a body.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `plane` | string | No | "YZ" | Mirror plane: "XY", "XZ", "YZ" |
| `body_index` | integer | No | Last | Which body to mirror |

**Plane Selection**:
```python
# Left-right symmetry (mirror across YZ plane)
mirror(plane="YZ")

# Front-back symmetry (mirror across XZ plane)
mirror(plane="XZ")

# Top-bottom symmetry (mirror across XY plane)
mirror(plane="XY")
```

### 2.5 Component and Assembly Tools

#### `create_component(name=None)`
Converts the most recent body into a named component.

#### `list_components()`
Returns all components with positions and bounding boxes.

#### `delete_component(name=None, index=None)`
Removes a component by name or index.

#### `check_interference()`
Detects bounding box collisions. **MANDATORY** after every component creation.

### 2.6 NEW: Component Positioning ÃƒÂ¢Ã‚Â­Ã‚Â CRITICAL

#### `move_component(x=0, y=0, z=0, index=None, name=None, absolute=True)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Moves a component to a new position.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `x, y, z` | number | No | 0 | Target position or offset (cm) |
| `index` | integer | No | None | Component index |
| `name` | string | No | None | Component name |
| `absolute` | boolean | No | True | Absolute position vs. relative offset |

**Examples**:
```python
# Move component to absolute position
move_component(x=0, y=10, z=5, index=1)

# Move component by relative offset
move_component(x=5, y=0, z=0, index=0, absolute=False)

# Move by name
move_component(x=0, y=0, z=10, name="Top_Cover")
```

**Why This Matters**:
Previously, all geometry started at origin causing overlaps. Now you can:
1. Create geometry centered at origin (easiest to design)
2. Convert to component
3. Move to final position

```python
# NEW ASSEMBLY WORKFLOW
# Step 1: Create base at origin
create_sketch(plane="XY")
draw_rectangle(x1=-10, y1=-10, x2=10, y2=10)
finish_sketch()
extrude(distance=2)
create_component(name="Base")

# Step 2: Create top at origin (easier to design centered)
create_sketch(plane="XY")
draw_rectangle(x1=-8, y1=-8, x2=8, y2=8)
finish_sketch()
extrude(distance=3)
create_component(name="Top")

# Step 3: Move top to proper position
move_component(z=2, name="Top")  # Now sits on top of base!

# Step 4: Verify
list_components()
check_interference()
```

#### `rotate_component(angle, axis="Z", index=None, name=None, origin_x=0, origin_y=0, origin_z=0)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Rotates a component around an axis.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `angle` | number | Yes | - | Rotation angle (degrees) |
| `axis` | string | No | "Z" | Rotation axis: "X", "Y", "Z" |
| `index` | integer | No | None | Component index |
| `name` | string | No | None | Component name |
| `origin_x/y/z` | number | No | 0 | Rotation origin point (cm) |

**Examples**:
```python
# Rotate 45Ãƒâ€šÃ‚Â° around Z-axis
rotate_component(angle=45, axis="Z", index=1)

# Rotate around a specific point
rotate_component(angle=90, axis="X", name="Arm", origin_z=5)
```

### 2.7 Joint System

#### `create_revolute_joint(...)`
Creates a hinge-type rotating joint.

**Parameters**:
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `component1_index` | int | Auto | First component |
| `component2_index` | int | Auto | Second component |
| `x, y, z` | number | 0 | Joint origin (cm) |
| `axis_x, axis_y, axis_z` | number | 0,0,1 | Rotation axis |
| `min_angle, max_angle` | number | None | Limits (degrees) |
| `flip` | boolean | False | Flip direction |

#### `create_slider_joint(...)`
Creates a linear sliding joint.

**Parameters**:
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `component1_index` | int | Auto | First component |
| `component2_index` | int | Auto | Second component |
| `x, y, z` | number | 0 | Joint origin (cm) |
| `axis_x, axis_y, axis_z` | number | 1,0,0 | Slide axis |
| `min_distance, max_distance` | number | None | Limits (cm) |

#### `set_joint_angle(angle, joint_index=None)`
Animates a revolute joint.

#### `set_joint_distance(distance, joint_index=None)`
Animates a slider joint.

### 2.8 NEW: Inspection and Measurement

#### `get_body_info(body_index=None)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Returns detailed information about edges and faces.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `body_index` | integer | No | Last | Which body to inspect |

**Returns**:
```json
{
  "body_name": "Body1",
  "edge_count": 12,
  "face_count": 6,
  "edges": [
    {"index": 0, "length": 10.0, "start": {"x": -5, "y": -5, "z": 0}, "end": {"x": 5, "y": -5, "z": 0}},
    {"index": 1, "length": 10.0, ...},
    ...
  ],
  "faces": [
    {"index": 0, "area": 100.0, "centroid": {"x": 0, "y": 0, "z": 2}},
    {"index": 1, "area": 20.0, ...},
    ...
  ]
}
```

**Use Cases**:
- Find edge indices for selective fillet/chamfer
- Find face indices for shell openings or draft
- Understand geometry structure

#### `measure(type="body", body_index=None, edge_index=None, face_index=None)` ÃƒÂ¢Ã‚Â­Ã‚Â NEW
Measures dimensions of geometry.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `type` | string | No | "body" | "body", "edge", or "face" |
| `body_index` | integer | No | Last | Which body |
| `edge_index` | integer | No | - | Edge to measure |
| `face_index` | integer | No | - | Face to measure |

**Returns by Type**:
```python
# type="body"
{
  "volume": 150.0,      # cmÃƒâ€šÃ‚Â³
  "surface_area": 220.0, # cmÃƒâ€šÃ‚Â²
  "bounding_box": {
    "min": {"x": -5, "y": -5, "z": 0},
    "max": {"x": 5, "y": 5, "z": 3},
    "size": {"x": 10, "y": 10, "z": 3}
  }
}

# type="edge"
{"edge_index": 5, "length": 10.0}

# type="face"
{"face_index": 2, "area": 30.0}
```

### 2.9 View, Export, Import, and Batch

#### `fit_view()`
Adjusts camera to show all geometry.

#### `get_design_info()`
Returns design statistics.

#### `export_stl(filepath)` / `export_step(filepath)` / `export_3mf(filepath)`
Export to various formats.

#### `import_mesh(filepath, unit="mm")`
Import mesh files.

#### `batch(commands)`
Execute multiple commands in one call.

```python
batch([
    {"name": "create_sketch", "params": {"plane": "XY"}},
    {"name": "draw_rectangle", "params": {"x1": -5, "y1": -5, "x2": 5, "y2": 5}},
    {"name": "finish_sketch", "params": {}},
    {"name": "extrude", "params": {"distance": 2}},
    {"name": "shell", "params": {"thickness": 0.2, "faces_to_remove": [0]}},
    {"name": "create_component", "params": {"name": "Container"}}
])
```

---

## ⚠️ CRITICAL: NEVER AUTO-JOIN BODIES

**HARD RULE: Create bodies separately, get user verification, THEN join.**

This is non-negotiable. Joining is destructive and cannot be easily undone.

### The Protocol (MANDATORY)
```python
# 1. Create geometry as separate body
create_sketch(...)
draw_polygon(...)
finish_sketch()
extrude(...)  # Creates NEW BODY

# 2. Check body count
get_design_info()  # Confirm body_count increased

# 3. STOP AND ASK USER
# "Created [part name] as separate body. Please verify position/shape."
# "Confirm to join?"

# 4. ONLY after user says yes:
combine(operation="join", target_body=0, tool_bodies=[1])
```

### Why This Matters
- Joined geometry cannot be easily separated
- Mistakes discovered after joining require manual undo
- User verification catches errors BEFORE they're permanent

### Real-World Failure (2025-12-17)
Created rain guard → immediately joined without verification → geometry merged incorrectly creating embedded diamond shape instead of hexagon → required user to manually undo multiple operations.

**Lesson:** The 10 seconds saved by auto-joining cost 10 minutes of cleanup.

---

## Section 3: Assembly Positioning Mastery

### 3.1 The New Workflow (v7.0)

With `move_component`, assembly positioning is dramatically simplified:

**OLD Workflow (v6.0 and earlier)**:
```python
# Had to offset geometry in the sketch itself
create_sketch(plane="XY")
draw_rectangle(x1=15, y1=-5, x2=25, y2=5)  # Offset in sketch
finish_sketch()
extrude(distance=2)
create_component(name="Part2")
```

**NEW Workflow (v7.0)**:
```python
# Create centered at origin (easier to design)
create_sketch(plane="XY")
draw_rectangle(x1=-5, y1=-5, x2=5, y2=5)
finish_sketch()
extrude(distance=2)
create_component(name="Part2")

# Move to final position
move_component(x=20, y=0, z=0, name="Part2")
```

### 3.2 Complete Assembly Example

**Task**: Create a box with lid

```python
# STEP 1: Create box body
batch([
    {"name": "create_sketch", "params": {"plane": "XY"}},
    {"name": "draw_rectangle", "params": {"x1": -5, "y1": -5, "x2": 5, "y2": 5}},
    {"name": "finish_sketch", "params": {}},
    {"name": "extrude", "params": {"distance": 4}}
])

# Shell to make it hollow (open top)
get_body_info()  # Find top face
shell(thickness=0.2, faces_to_remove=[0])
create_component(name="Box_Body")

# STEP 2: Create lid (at origin for easy design)
batch([
    {"name": "create_sketch", "params": {"plane": "XY"}},
    {"name": "draw_rectangle", "params": {"x1": -5.2, "y1": -5.2, "x2": 5.2, "y2": 5.2}},
    {"name": "finish_sketch", "params": {}},
    {"name": "extrude", "params": {"distance": 0.5}}
])
create_component(name="Lid")

# STEP 3: Position lid on top of box
move_component(z=4, name="Lid")

# STEP 4: Add hinge joint
create_revolute_joint(
    component1_index=0,
    component2_index=1,
    x=-5.2, y=0, z=4,
    axis_x=0, axis_y=1, axis_z=0,
    min_angle=0, max_angle=120
)

# STEP 5: Verify
list_components()
check_interference()
fit_view()

# Test the hinge
set_joint_angle(45)
```

### 3.3 Assembly Verification Protocol

**MANDATORY after every component creation**:

```python
# Step 1: Check positions
list_components()

# Step 2: Check interference
check_interference()

# Step 3: Verify dimensions
measure(type="body")

# Step 4: Visual check
fit_view()
```

---

## Section 4: Manufacturing Design Guidelines

### 4.1 Design for 3D Printing (FDM)

| Feature | Minimum | Recommended |
|---------|---------|-------------|
| Wall thickness | 0.08cm | 0.12cm+ |
| Hole diameter | Design + 0.02cm | Design + 0.04cm |
| Overhang angle | 45Ãƒâ€šÃ‚Â° | 35Ãƒâ€šÃ‚Â° |

### 4.2 Design for SLA/Resin

| Feature | Minimum |
|---------|---------|
| Wall thickness | 0.06cm |
| Drain holes | 0.2-0.3cm diameter |
| Feature size | 0.03cm |

### 4.3 Design for CNC

| Feature | Guideline |
|---------|-----------|
| Internal corners | Radius ÃƒÂ¢Ã¢â‚¬Â°Ã‚Â¥ tool radius |
| Wall thickness | ÃƒÂ¢Ã¢â‚¬Â°Ã‚Â¥ 0.08cm |
| Hole depth | ÃƒÂ¢Ã¢â‚¬Â°Ã‚Â¤ 4ÃƒÆ’Ã¢â‚¬â€ diameter |

### 4.4 Design for Injection Molding

| Feature | Specification |
|---------|---------------|
| Wall thickness | 0.15-0.25cm |
| Draft angle | 1Ãƒâ€šÃ‚Â° per inch minimum |
| Rib thickness | 50-60% of wall |
| Internal fillet | ÃƒÂ¢Ã¢â‚¬Â°Ã‚Â¥ 50% wall thickness |

**Using Draft Tool**:
```python
# After creating geometry
draft(angle=1.0)  # 1Ãƒâ€šÃ‚Â° draft on all faces

# Or selective draft
get_body_info()  # Find vertical face indices
draft(angle=1.5, faces=[1, 2, 3, 4])  # Vertical faces only
```

---

## Section 5: Quick Reference

### 5.1 Tool Summary Table

| Category | Tool | Key Parameters |
|----------|------|----------------|
| **Sketch** | `create_sketch` | plane, offset |
| | `finish_sketch` | - |
| | `draw_rectangle` | x1, y1, x2, y2 |
| | `draw_circle` | center_x, center_y, radius |
| | `draw_line` | x1, y1, x2, y2 |
| | `draw_arc` | center, start, end |
| | `draw_polygon` | center, radius, sides |
| **Features** | `extrude` | distance, taper_angle |
| | `revolve` | angle |
| | `fillet` | radius, edges |
| | `chamfer` | distance, edges |
| | `shell` | thickness, faces_to_remove |
| | `draft` | angle, faces |
| | `pattern_rectangular` | x/y_count, x/y_spacing |
| | `pattern_circular` | count, angle, axis |
| | `mirror` | plane |
| **Components** | `create_component` | name |
| | `list_components` | - |
| | `delete_component` | name/index |
| | `check_interference` | - |
| | `move_component` | x, y, z, absolute |
| | `rotate_component` | angle, axis |
| **Joints** | `create_revolute_joint` | position, axis, limits |
| | `create_slider_joint` | position, axis, limits |
| | `set_joint_angle` | angle |
| | `set_joint_distance` | distance |
| **Inspection** | `get_body_info` | body_index |
| | `measure` | type, indices |
| | `get_design_info` | - |
| | `fit_view` | - |
| **Export** | `export_stl` | filepath |
| | `export_step` | filepath |
| | `export_3mf` | filepath |
| **Import** | `import_mesh` | filepath, unit |
| **Batch** | `batch` | commands |

### 5.2 Unit Conversion

```
ALWAYS USE CENTIMETERS

mm ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ cm: ÃƒÆ’Ã‚Â· 10     (5mm = 0.5cm)
inches ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ cm: ÃƒÆ’Ã¢â‚¬â€ 2.54  (1" = 2.54cm)
m ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ cm: ÃƒÆ’Ã¢â‚¬â€ 100     (0.1m = 10cm)
```

### 5.3 Plane Selection

```
Horizontal surface  ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ XY (extrude Ãƒâ€šÃ‚Â±Z)
Vertical front      ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ XZ (extrude Ãƒâ€šÃ‚Â±Y)
Side profile        ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ YZ (extrude Ãƒâ€šÃ‚Â±X)
```

### 5.4 Verification Commands

```python
list_components()      # Check positions
check_interference()   # Check overlaps
get_body_info()        # Get edge/face indices
measure()              # Verify dimensions
fit_view()             # Visual check
```

---

## Document Metadata

```yaml
skill_name: fusion360-mcp
version: 1.0.0
mcp_version: 7.0.0
target_model: claude-opus-4-5
last_updated: 2025-12
changes_from_v4.4:
  - INTEGRATED CPI_Fusion360_UnitConfusion (VERIFIED)
  - INTEGRATED CPI_Fusion360_ExtrusionDirection (VERIFIED)
  - INTEGRATED CPI_Fusion360_ComponentPositioning (VERIFIED)
  - INTEGRATED CPI_Fusion360_BladeBevels (VERIFIED)
  - Added Section 6: VERIFIED Lessons Learned
  - Added unit conversion red flags
  - Added pre-extrusion checklist
  - Added component positioning mental models
  - Added blade bevel chamfer protocol
  - Added edge identification for complex models
```

---

*End of Fusion 360 MCP Skill Guide for Claude Opus v4.5*



## Section 6: VERIFIED Lessons Learned (CPI Integration)

The following hard constraints have been VERIFIED through documented failures and successful resolution. These are NOT suggestions - they are MANDATORY protocols.

---

### 6.1 Unit Confusion (CPI_Fusion360_UnitConfusion)

**STATUS: VERIFIED** ?

**The Golden Rule: ALL Fusion 360 MCP dimensions are in CENTIMETERS.**

| Real World | MCP Value | Example |
|------------|-----------|---------|
| 1mm | 0.1 | M3 screw = 0.3cm |
| 5mm | 0.5 | Small gap |
| 10mm | 1.0 | 1cm (easy) |
| 25mm | 2.5 | ~1 inch |
| 50mm | 5.0 | |
| 100mm | 10.0 | |

**Common Component Sizes (in cm for MCP):**

| Component | Real Size | MCP Values |
|-----------|-----------|------------|
| Raspberry Pi 4 | 85x56mm | 8.5 x 5.6 |
| Pi Zero | 65x30mm | 6.5 x 3.0 |
| 18650 Battery | 65x18mm | 6.5 x 1.8 |

**RED FLAGS - STOP AND VERIFY:**
- Value > 50: Are you sure? That is 50cm = ~20 inches
- Value > 100: Very likely mm/cm confusion
- Value > 200: Almost certainly wrong

**Quick Mental Math:**
- mm to cm: Move decimal LEFT one place (165mm ? 16.5cm)
- cm to mm: Move decimal RIGHT one place (8.5cm ? 85mm)

---

### 6.2 Extrusion Direction (CPI_Fusion360_ExtrusionDirection)

**STATUS: VERIFIED** ?

**Pre-Extrusion Checklist (MANDATORY):**
1. Identify target: Where should material END UP?
2. Identify sketch plane: Where is the sketch located?
3. Calculate direction: Does positive or negative get me there?
4. Verify operation: This creates a NEW BODY (no join/cut in MCP)

**Plane to Extrusion Direction Mapping:**

| Sketch Plane | +Distance Goes | -Distance Goes |
|--------------|----------------|----------------|
| XY (offset=0) | +Z (up) | -Z (down) |
| XY (offset=5) | +Z (up from offset) | -Z (toward origin) |
| XZ | +Y (toward viewer) | -Y (away) |
| YZ | +X (right) | -X (left) |

**Common Scenario - Creating a Lid on Top of a Case:**
```python
# Case top surface at Z = 3cm, want 0.5cm thick lid
create_sketch(plane="XY", offset=3)  # Sketch at top of case
draw_rectangle(...)                   # Lid outline
finish_sketch()
extrude(distance=0.5)                # +Z = up, AWAY from case = CORRECT
# extrude(distance=-0.5)             # -Z = down, INTO case = WRONG (would cut)
```

---

### 6.3 Component Positioning (CPI_Fusion360_ComponentPositioning)

**STATUS: VERIFIED** ?

**Stacking Mental Model:**

"Stacking" means components OVERLAP in XY view (same X,Y, different Z):
```
Top View (looking down Z axis):
+-------------------+
| All components    |  Overlapping in XY
| at same X,Y       |
| different Z       |
+-------------------+
```

"Spreading" means components are ADJACENT (different X,Y, same Z):
```
Top View:
+-------+ +-------+ +-------+
| Comp1 | | Comp2 | | Comp3 |  Different X,Y positions
+-------+ +-------+ +-------+
```

**Pre-Positioning Checklist (MANDATORY):**
1. Query First: `list_components()` to get positions and sizes
2. Clarify Layout: Ask user "Stacked along which axis?" if unclear
3. Plan Offsets: Calculate Z offsets based on component heights
4. Verify After: Check new positions match intent

**Stack Height Calculation:**
```python
# For vertical stack:
# Component 1: Z = 0
# Component 2: Z = Height of Comp1 + gap
# Component 3: Z = Height of (Comp1 + Comp2) + gap
move_component(name="Display", x=0, y=0, z=0)
move_component(name="Pi", x=0, y=0, z=display_height + 0.1)
move_component(name="Battery", x=0, y=0, z=display_height + pi_height + 0.2)
```

---

### 6.4 Blade Bevels with Chamfer (CPI_Fusion360_BladeBevels)

**STATUS: VERIFIED** ?

**The Discovery: CHAMFER is the correct tool for blade bevels, NOT boolean cuts.**

**Why Chamfer Works:**
- Direct edge selection - no positioning required
- Built-in to MCP as `chamfer(edges=[], distance=X)`
- Clean, predictable results

**Why Boolean Cuts Failed:**
- MCP lacks native combine() with cut operation
- Positioning cutting bodies precisely is error-prone
- Coordinate confusion led to multiple failed attempts

**Chamfer Distance Formula:**
```
Sharp edge meeting at centerline: chamfer_distance = blade_thickness / 2
Partial bevel (leaves flat spine): chamfer_distance < blade_thickness / 2
```

**Edge Identification Protocol (for models with 50+ edges):**
```python
# Step 1: Get basic body info (shows first 50 edges)
get_body_info(body_index=0)

# Step 2: Search for long edges by measurement
batch([
    {"name": "measure", "params": {"type": "edge", "body_index": 0, "edge_index": 100}},
    {"name": "measure", "params": {"type": "edge", "body_index": 0, "edge_index": 150}},
    {"name": "measure", "params": {"type": "edge", "body_index": 0, "edge_index": 175}},
])

# Step 3: Identify blade edges by length
# Blade edges: ~85cm (main blade length)
# Grip edges: ~75cm (handle length)
```

**HARD CONSTRAINTS:**
- Always use `get_body_info()` first to understand edge structure
- Use `measure()` to find edges beyond the 50-edge display limit
- Verify chamfer distance is appropriate for blade thickness
- Chamfer BOTH sides for symmetric blade

---

### 6.5 CPI Cross-Reference Index

| CPI Document | Key Lesson | Hard Constraint |
|--------------|------------|-----------------|
| UnitConfusion | ALL values in cm | Divide mm by 10 before API call |
| ExtrusionDirection | Know where material goes | Check plane?direction mapping |
| ComponentPositioning | Stack vs Spread | Query positions BEFORE moving |
| BladeBevels | Use chamfer for edges | Never use boolean cuts for bevels |

---



---

## Save vs Export (Critical Distinction)

| Action | What It Does | Result |
|--------|--------------|--------|
| **Save** | Persists .f3d design to Fusion cloud | Design preserved in Fusion |
| **Export** | Creates copy in external format | STL/STEP file on disk |

**Ã¢Å¡Â Ã¯Â¸Â Export does NOT save the design.** These are separate operations.

The current MCP does not have a `save_design` command. If a user asks to "save", you must:
1. Inform them: "The MCP cannot save directly to Fusion 360's cloud storage"
2. Request they manually save via **File Ã¢â€ â€™ Save** or **Ctrl+S**
3. Wait for confirmation before proceeding
4. Then export if also requested

