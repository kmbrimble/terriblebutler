import { useState } from 'react';
import { createCategory, updateCategory, deleteCategory, type Category } from '../lib/api';
import { showToast } from '../lib/toast';

// Ports openManageCategories()/renderManageCategories()/addCategory()/editCategory()/
// deleteCategory() from public/index.html L864-914 — same prompt()-based rename and
// confirm()-based delete, same non-blocking behaviour (deleting a category in use just detaches
// it from items server-side; no client-side guard). `categories` is kept current via
// ItemList.tsx's existing categories_updated socket listener, same as legacy's global array.
export function ManageCategoriesModal({ categories, onClose }: { categories: Category[]; onClose: () => void }) {
  const [newName, setNewName] = useState('');

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    try {
      await createCategory(name);
      setNewName('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add category.', 'error');
    }
  }

  async function handleEdit(category: Category) {
    const newCategoryName = window.prompt('Enter new category name:', category.name);
    if (!newCategoryName || newCategoryName === category.name) return;
    try {
      await updateCategory(category.id, newCategoryName);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update category.', 'error');
    }
  }

  async function handleDelete(category: Category) {
    if (!window.confirm('Delete this category? Items in this category will not be deleted.')) return;
    try {
      await deleteCategory(category.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete category.', 'error');
    }
  }

  return (
    <div data-testid="manage-categories-modal" className="fixed inset-0 bg-black bg-opacity-80 z-[60] flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-md max-h-[90vh] flex flex-col p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-rimmy-orange">Manage Categories</h2>
          <button type="button" onClick={onClose} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          <input
            type="text"
            data-testid="manage-categories-new-input"
            placeholder="New category name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 bg-rimmy-black border border-rimmy-border focus:border-rimmy-orange outline-none rounded p-2 touch-target text-rimmy-text"
          />
          <button type="button" onClick={handleAdd} className="touch-target px-4 bg-rimmy-purple hover:bg-rimmy-purpleHover text-white font-bold rounded shadow-sm">
            Add
          </button>
        </div>

        <ul className="flex flex-col gap-2 flex-1 overflow-y-auto pr-1">
          {categories.map((c) => (
            <li
              key={c.id}
              data-testid="manage-category-row"
              data-category-id={c.id}
              className="flex justify-between items-center bg-rimmy-black border border-rimmy-border rounded p-2"
            >
              <span className="text-rimmy-text font-bold truncate pr-2">{c.name}</span>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  data-testid="manage-category-edit-button"
                  onClick={() => handleEdit(c)}
                  className="text-rimmy-textMuted hover:text-rimmy-orange touch-target px-2 border border-rimmy-border rounded"
                >
                  Edit
                </button>
                <button
                  type="button"
                  data-testid="manage-category-delete-button"
                  onClick={() => handleDelete(c)}
                  className="text-red-500 hover:text-red-700 font-bold touch-target px-2 border border-rimmy-border rounded"
                >
                  X
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
