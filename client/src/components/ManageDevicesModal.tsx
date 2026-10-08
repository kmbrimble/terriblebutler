import { useEffect, useState } from 'react';
import { PasswordConfirmDialog } from './PasswordConfirmDialog';
import { getDevices, revokeAllSessions, revokeDevice, type DeviceToken } from '../lib/api';
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

  // Revoking needs the household password again (a fresh login), whatever token this device
  // holds; the confirm dialog collects it. Wrong password: the dialog stays open with the error.
  const [pending, setPending] = useState<{ kind: 'device'; device: DeviceToken } | { kind: 'all' } | null>(null);

  async function confirmPending(password: string) {
    if (!pending) return;
    if (pending.kind === 'device') {
      await revokeDevice(pending.device.id, password);
      setPending(null);
      refresh();
    } else {
      // On success api.ts ends the session, which sends App back to the login screen.
      await revokeAllSessions(password);
    }
  }

  return (
    <div data-testid="manage-devices-modal" className="fixed inset-0 bg-black/80 z-60 flex items-center justify-center p-4">
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
                  onClick={() => setPending({ kind: 'device', device: d })}
                  className="shrink-0 text-red-500 hover:text-red-700 font-bold touch-target px-2 border border-rimmy-border rounded"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>

        <button
          type="button"
          data-testid="manage-devices-sign-out-everywhere"
          onClick={() => setPending({ kind: 'all' })}
          className="mt-4 shrink-0 text-red-500 hover:text-red-700 font-bold py-2 border border-rimmy-border rounded"
        >
          Sign out everywhere
        </button>
      </div>
      {pending && (
        <PasswordConfirmDialog
          title={pending.kind === 'device' ? `Revoke ${pending.device.device_label}?` : 'Sign out everywhere?'}
          message={
            pending.kind === 'device'
              ? 'It will need to log in again to regain access. Enter the household password to confirm.'
              : 'Every device, including this one, will need to log in again. Enter the household password to confirm.'
          }
          confirmLabel={pending.kind === 'device' ? 'Revoke' : 'Sign out everywhere'}
          onConfirm={confirmPending}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
