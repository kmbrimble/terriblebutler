function registerPriceHistoryRoutes(app, { db, broadcastUpdate, getItem, recalculateItemPrices }) {
  app.delete('/api/price-history/:id', (req, res) => {
    const row = db.prepare('SELECT item_id FROM price_history WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Price history entry not found' });
    db.transaction(() => {
      db.prepare('DELETE FROM price_history WHERE id = ?').run(req.params.id);
      recalculateItemPrices(row.item_id);
    })();
    broadcastUpdate('price_history_updated', getItem(row.item_id));
    res.json({ message: 'Price history entry deleted' });
  });
}

module.exports = { registerPriceHistoryRoutes };
