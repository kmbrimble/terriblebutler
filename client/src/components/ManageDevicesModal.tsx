import { useEffect, useState } from 'react';
import { getDevices, revokeDevice, type DeviceToken } from '../lib/api';
import { showToast } from '../lib/toast';
import { useLockBodyScroll } from '../lib/useLockBodyScroll';

// Unlike ManageCategoriesModal/ManageLocationsModal, devices have no existing global state
// kept live by a socket listener, so this modal fetches its own list on mount and after
// each revoke.
export function ManageDevicesModal({ onClose }: { onClose: () => void }) {
  useLockBodyScroll();
  const [devices, setDevices] = useState<DeviceToken[]>([]);

  function refresh() {
    getDevices()
      .then(setDevices)
      .catch((err) => showToast(err instanceof Error ? err.message : 'Failed to fetch devices.', 'error'));
  }

  useEffect(refresh, []);

  async function handleRevoke(device: DeviceToken) {
    if (!window.confirm('Revoke this device? It will need to log in again to regain access.')) return;
    try {
      await revokeDevice(device.id);
      refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to revoke device.', 'error');
    }
  }

  return (
    <div data-testid="manage-devices-modal" className="fixed inset-0 bg-black bg-opacity-80 z-[60] flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-md max-h-[90vh] flex flex-col p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-rimmy-orange">Manage Devices</h2>
          <button type="button" onClick={onClose} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>

        <ul className="flex flex-col gap-2 flex-1 overflow-y-auto pr-1">
          {devices.map((d) => (
            <li
              key={d.id}
              data-testid="manage-device-row"
              data-device-id={d.id}
              className="flex justify-between items-center bg-rimmy-black border border-rimmy-border rounded p-2"
            >
              <div className="truncate pr-2">
                <div className="text-rimmy-text font-bold truncate">{d.device_label}</div>
                <div className="text-rimmy-textMuted text-xs">{d.revoked ? 'Revoked' : `Last used ${d.last_used_at}`}</div>
              </div>
              {!d.revoked && (
                <button
                  type="button"
                  data-testid="manage-device-revoke-button"
                  onClick={() => handleRevoke(d)}
                  className="shrink-0 text-red-500 hover:text-red-700 font-bold touch-target px-2 border border-rimmy-border rounded"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
