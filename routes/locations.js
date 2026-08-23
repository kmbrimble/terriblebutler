function registerLocationRoutes(app, { db, broadcastUpdate }) {
  app.get('/api/locations', (req, res) => {
    res.json(db.prepare('SELECT * FROM locations').all());
  });

  app.post('/api/locations', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
      const info = db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
      broadcastUpdate('locations_updated', {});
      res.status(201).json({ id: info.lastInsertRowid, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/locations/:id', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
      const info = db.prepare('UPDATE locations SET name = ? WHERE id = ?').run(name, req.params.id);
      if (!info.changes) return res.status(404).json({ error: 'Location not found' });
      broadcastUpdate('locations_updated', {});
      res.json({ id: req.params.id, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/locations/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT id FROM locations WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Location not found' });
      db.transaction(() => {
        const stranded = db.prepare('SELECT id, item_id, quantity FROM item_locations WHERE location_id = ?').all(req.params.id);
        for (const row of stranded) {
          const unassigned = db.prepare('SELECT id, quantity FROM item_locations WHERE item_id = ? AND location_id IS NULL').get(row.item_id);
          if (unassigned) {
            db.prepare('UPDATE item_locations SET quantity = quantity + ? WHERE id = ?').run(row.quantity, unassigned.id);
            db.prepare('DELETE FROM item_locations WHERE id = ?').run(row.id);
          } else {
            db.prepare('UPDATE item_locations SET location_id = NULL WHERE id = ?').run(row.id);
          }
        }
        db.prepare('UPDATE invoice_import_lines SET suggested_location_id = NULL WHERE suggested_location_id = ?').run(req.params.id);
        db.prepare('UPDATE invoice_import_lines SET final_location_id = NULL WHERE final_location_id = ?').run(req.params.id);
        db.prepare('DELETE FROM locations WHERE id = ?').run(req.params.id);
      })();
      broadcastUpdate('locations_updated', {});
      res.json({ message: 'Location deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerLocationRoutes };
