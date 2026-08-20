import { useState } from 'react';
import { createLocation, updateLocation, deleteLocation, type Location } from '../lib/api';
import { showToast } from '../lib/toast';
import { useLockBodyScroll } from '../lib/useLockBodyScroll';

// Ports openManageLocations()/renderManageLocations()/addLocation()/editLocation()/
// deleteLocation() from public/index.html L917-967 — same shape as ManageCategoriesModal.
export function ManageLocationsModal({ locations, onClose }: { locations: Location[]; onClose: () => void }) {
  useLockBodyScroll();
  const [newName, setNewName] = useState('');

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    try {
      await createLocation(name);
      setNewName('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add location.', 'error');
    }
  }

  async function handleEdit(location: Location) {
    const newLocationName = window.prompt('Enter new location name:', location.name);
    if (!newLocationName || newLocationName === location.name) return;
    try {
      await updateLocation(location.id, newLocationName);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update location.', 'error');
    }
  }

  async function handleDelete(location: Location) {
    if (!window.confirm('Delete this location? Items in this location will not be deleted.')) return;
    try {
      await deleteLocation(location.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete location.', 'error');
    }
  }

  return (
    <div data-testid="manage-locations-modal" className="fixed inset-0 bg-black bg-opacity-80 z-[60] flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-md max-h-[90vh] flex flex-col p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-rimmy-orange">Manage Locations</h2>
          <button type="button" onClick={onClose} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          <input
            type="text"
            data-testid="manage-locations-new-input"
            placeholder="New location name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 bg-rimmy-black border border-rimmy-border focus:border-rimmy-orange outline-none rounded p-2 touch-target text-rimmy-text"
          />
          <button type="button" onClick={handleAdd} className="touch-target px-4 bg-rimmy-purple hover:bg-rimmy-purpleHover text-white font-bold rounded shadow-sm">
            Add
          </button>
        </div>

        <ul className="flex flex-col gap-2 flex-1 overflow-y-auto pr-1">
          {locations.map((l) => (
            <li
              key={l.id}
              data-testid="manage-location-row"
              data-location-id={l.id}
              className="flex justify-between items-center bg-rimmy-black border border-rimmy-border rounded p-2"
            >
              <span className="text-rimmy-text font-bold truncate pr-2">{l.name}</span>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  data-testid="manage-location-edit-button"
                  onClick={() => handleEdit(l)}
                  className="text-rimmy-textMuted hover:text-rimmy-orange touch-target px-2 border border-rimmy-border rounded"
                >
                  Edit
                </button>
                <button
                  type="button"
                  data-testid="manage-location-delete-button"
                  onClick={() => handleDelete(l)}
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
