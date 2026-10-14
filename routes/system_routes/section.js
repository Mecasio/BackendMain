const express = require('express');
const { db, db3 } = require('../database/database');
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");

const router = express.Router();

// INSERT WITH DUPLICATE CHECK
router.post("/section_table", CanCreate, async (req, res) => {
  const { description } = req.body;
  if (!description) {
    return res.status(400).json({ error: "Description is required" });
  }

  try {
    // Check Duplicate
    const checkQuery = "SELECT * FROM section_table WHERE description = ?";
    const [exists] = await db3.query(checkQuery, [description]);

    if (exists.length > 0) {
      return res.status(409).json({ error: "Section already exists" });
    }

    const insertQuery = "INSERT INTO section_table (description) VALUES (?)";
    const [result] = await db3.query(insertQuery, [description]);

    res.status(201).json({
      message: "Section created successfully",
      sectionId: result.insertId,
    });
  } catch (err) {
    console.error("Error inserting section:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// UPDATE SECTION
router.put("/section_table/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { description } = req.body;

  if (!description) {
    return res.status(400).json({ error: "Description is required" });
  }

  try {
    // Check duplicate
    const checkQuery =
      "SELECT * FROM section_table WHERE description = ? AND id != ?";
    const [exists] = await db3.query(checkQuery, [description, id]);

    if (exists.length > 0) {
      return res.status(409).json({ error: "Section already exists" });
    }

    const updateQuery = "UPDATE section_table SET description = ? WHERE id = ?";
    await db3.query(updateQuery, [description, id]);

    res.status(200).json({ message: "Section updated successfully" });
  } catch (err) {
    console.error("Error updating section:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE SECTION
router.delete("/section_table/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const deleteQuery = "DELETE FROM section_table WHERE id = ?";
    await db3.query(deleteQuery, [id]);

    res.status(200).json({ message: "Section deleted successfully" });
  } catch (err) {
    console.error("Error deleting section:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// SECTIONS LIST (UPDATED!)
router.get("/section_table", async (req, res) => {
  try {
    const query = "SELECT * FROM section_table";
    const [result] = await db3.query(query);
    res.status(200).json(result);
  } catch (err) {
    console.error("Error fetching sections:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

module.exports = router;
