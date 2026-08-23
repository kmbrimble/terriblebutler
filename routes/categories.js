function registerCategoryRoutes(app, { db, broadcastUpdate }) {
  app.get('/api/categories', (req, res) => {
    res.json(db.prepare('SELECT * FROM categories').all());
  });

  app.post('/api/categories', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
      const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
      broadcastUpdate('categories_updated', {});
      res.status(201).json({ id: info.lastInsertRowid, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/categories/:id', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
      const info = db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, req.params.id);
      if (!info.changes) return res.status(404).json({ error: 'Category not found' });
      broadcastUpdate('categories_updated', {});
      res.json({ id: req.params.id, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/categories/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT id FROM categories WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Category not found' });
      db.transaction(() => {
        db.prepare('UPDATE items SET category_id = NULL WHERE category_id = ?').run(req.params.id);
        db.prepare('UPDATE invoice_import_lines SET suggested_category_id = NULL WHERE suggested_category_id = ?').run(req.params.id);
        db.prepare('UPDATE invoice_import_lines SET final_category_id = NULL WHERE final_category_id = ?').run(req.params.id);
        db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
      })();
      broadcastUpdate('categories_updated', {});
      res.json({ message: 'Category deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerCategoryRoutes };
