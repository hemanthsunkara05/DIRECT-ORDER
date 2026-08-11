'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  notificationsApi,
  type NotificationItem,
  type NotificationPreferenceRow,
} from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';

const CATEGORY_LABEL: Record<string, string> = {
  SECURITY: 'Security',
  TRANSACTIONAL: 'Order updates',
  ACCOUNT: 'Account',
  MARKETING: 'Marketing',
};

const CHANNEL_LABEL: Record<string, string> = {
  IN_APP: 'In-app',
  SMS: 'SMS',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
};

export default function NotificationsPage() {
  return (
    <ProtectedRoute>
      <NotificationsDashboard />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function NotificationsDashboard() {
  const [notifications, setNotifications] = useState<NotificationItem[] | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferenceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefError, setPrefError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [page, prefs] = await Promise.all([
        notificationsApi.list({ limit: 50 }),
        notificationsApi.listPreferences(),
      ]);
      setNotifications(page.items);
      setPreferences(prefs.preferences);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleMarkRead(id: string) {
    try {
      await notificationsApi.markRead(id);
      setNotifications((prev) =>
        prev
          ? prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n))
          : prev,
      );
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function handleMarkAllRead() {
    try {
      await notificationsApi.markAllRead();
      setNotifications((prev) =>
        prev ? prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) : prev,
      );
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function handleTogglePreference(row: NotificationPreferenceRow) {
    setPrefError(null);
    const nextEnabled = !row.enabled;
    try {
      await notificationsApi.updatePreference({
        category: row.category,
        channel: row.channel,
        enabled: nextEnabled,
      });
      setPreferences((prev) =>
        prev
          ? prev.map((p) =>
              p.category === row.category && p.channel === row.channel
                ? { ...p, enabled: nextEnabled }
                : p,
            )
          : prev,
      );
    } catch (err) {
      setPrefError(formatError(err));
    }
  }

  const unreadCount = notifications?.filter((n) => !n.readAt).length ?? 0;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Notifications</h1>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void handleMarkAllRead()}
            className="text-sm underline"
          >
            Mark all read ({unreadCount})
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="flex flex-col gap-2">
        {notifications !== null && notifications.length === 0 && (
          <p className="text-sm text-slate-500">No notifications yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {notifications?.map((n) => (
            <li
              key={n.id}
              className={`flex items-start justify-between rounded-lg border p-3 text-sm ${
                n.readAt ? 'border-slate-100' : 'border-slate-300 bg-amber-50'
              }`}
            >
              <div>
                <p className="font-medium">{n.title}</p>
                <p className="text-slate-600">{n.body}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {new Date(n.createdAt).toLocaleString()}
                </p>
              </div>
              {!n.readAt && (
                <button
                  type="button"
                  onClick={() => void handleMarkRead(n.id)}
                  className="shrink-0 text-xs text-indigo-600 underline"
                >
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3 border-t border-slate-100 pt-6">
        <h2 className="text-sm font-semibold">Preferences</h2>
        <p className="text-xs text-slate-500">
          Order updates and security notifications cannot be turned off — they keep you informed
          about things that need your attention.
        </p>
        {prefError && <p className="text-sm text-red-600">{prefError}</p>}
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {(['TRANSACTIONAL', 'SECURITY', 'ACCOUNT', 'MARKETING'] as const).map((category) => (
            <div key={category} className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-sm font-medium">{CATEGORY_LABEL[category]}</p>
              <div className="flex flex-col gap-1">
                {preferences
                  ?.filter((p) => p.category === category)
                  .map((row) => (
                    <label
                      key={row.channel}
                      className="flex items-center justify-between text-sm text-slate-600"
                    >
                      <span>{CHANNEL_LABEL[row.channel]}</span>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        disabled={!row.disableable}
                        onChange={() => void handleTogglePreference(row)}
                      />
                    </label>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
