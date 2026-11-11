/**
 * ImplementationTurnLimitSetting.tsx - Instance-wide turn budget for
 * implementation runs (core/execution-loop.md, "Has a turn budget").
 *
 * A run that spends the budget is stopped instead of chaining to review.
 * 0 turns the cap off. Admin-only to edit, like the other app settings.
 */

import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useAuth } from '../contexts/AuthContext';
import { useAppSettings } from '../contexts/AppSettingsContext';
import { api } from '../utils/api';
import type { ApiError } from '../../shared/api/_common';

const MAX_TURNS = 10000;

function ImplementationTurnLimitSetting() {
  const { user } = useAuth();
  const { implementationMaxTurns, refresh } = useAppSettings();
  const isAdmin = user?.is_admin === 1;
  const [draft, setDraft] = useState(String(implementationMaxTurns));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(String(implementationMaxTurns));
  }, [implementationMaxTurns]);

  const trimmed = draft.trim();
  const turns = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  const isValid = Number.isInteger(turns) && turns <= MAX_TURNS;
  const isDirty = isValid && turns !== implementationMaxTurns;

  const handleSave = async () => {
    setError(null);
    setSaved(false);
    setIsSaving(true);
    try {
      const res = await api.appSettings.update({ implementation_max_turns: String(turns) });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiError;
        throw new Error(body.error || `Save failed: ${res.status}`);
      }
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3 mb-6">
      <h3 className="text-lg font-semibold text-foreground">Implementation turn limit</h3>
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <label htmlFor="implementation-max-turns" className="block text-sm text-muted-foreground">
          Maximum model turns one implementation run may take before it is stopped. A stopped
          run does not chain to review, and autopilot stops so you can look at the task.
          Use 0 for no limit. {isAdmin ? null : 'Admin access required to edit.'}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="implementation-max-turns"
            inputMode="numeric"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSaved(false);
            }}
            disabled={!isAdmin || isSaving}
            className="h-10 w-32"
            style={{ fontSize: '16px' }}
          />
          <span className="text-sm text-muted-foreground">
            {isValid && turns === 0 ? 'no limit' : 'turns'}
          </span>
          <Button
            onClick={handleSave}
            disabled={!isAdmin || isSaving || !isDirty}
            className="h-10 ml-auto"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
        {!isValid && trimmed !== '' && (
          <div className="text-sm text-red-600 dark:text-red-400">
            Enter a whole number from 0 to {MAX_TURNS}.
          </div>
        )}
        {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        {saved && <div className="text-sm text-green-600 dark:text-green-400">Saved.</div>}
      </div>
    </div>
  );
}

export default ImplementationTurnLimitSetting;
