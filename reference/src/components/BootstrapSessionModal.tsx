import React, { useState, useEffect, useRef } from 'react';
import { X, FileText } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { MicButton } from './MicButton';
import { ProviderModelPicker } from './ProviderModelPicker';
import { useProviderModelSelection } from '../hooks/useProviderModelSelection';
import type { Provider } from '../../shared/providers/types';
import type { BootstrapKind, BootstrapMode } from '../../shared/api/projects';

// One modal for the three project-bootstrap sessions (extra/project-bootstrap.md):
// Create/Refine PRD, Create/Refine ARD, Create initial tasks. Only the
// textarea label, placeholder, and whether it is required depend on the kind.

export interface BootstrapSessionPayload {
  input: string;
  provider: Provider;
  model: string;
}

export interface BootstrapSessionResult {
  success: boolean;
  error?: string;
}

export interface BootstrapSessionModalProps {
  isOpen: boolean;
  kind: BootstrapKind;
  mode: BootstrapMode;
  onClose: () => void;
  onSubmit: (payload: BootstrapSessionPayload) => Promise<BootstrapSessionResult | void>;
  projectName?: string;
  isSubmitting?: boolean;
}

interface FieldConfig {
  title: string;
  label: string;
  placeholder: string;
  required: boolean;
  submitLabel: string;
}

export function getBootstrapFieldConfig(kind: BootstrapKind, mode: BootstrapMode): FieldConfig {
  if (kind === 'tasks') {
    return {
      title: 'Create initial tasks',
      label: 'Guidance, e.g. "MVP only"',
      placeholder: 'Optional — anything the breakdown should focus on or leave out',
      required: false,
      submitLabel: 'Start breakdown',
    };
  }
  const doc = kind.toUpperCase();
  if (mode === 'refine') {
    return {
      title: `Refine ${doc}`,
      label: 'What should change?',
      placeholder: `Optional — leave empty to review ${doc}.md for gaps`,
      required: false,
      submitLabel: 'Start session',
    };
  }
  if (kind === 'prd') {
    return {
      title: 'Create PRD',
      label: 'Describe your idea',
      placeholder: 'e.g. A web app where office staff pre-order lunch from a weekly menu',
      required: true,
      submitLabel: 'Start interview',
    };
  }
  return {
    title: 'Create ARD',
    label: 'Constraints or preferences',
    placeholder: 'Optional — e.g. TypeScript everywhere, deploy to a single VPS, Postgres',
    required: false,
    submitLabel: 'Start interview',
  };
}

function BootstrapSessionModal({
  isOpen,
  kind,
  mode,
  onClose,
  onSubmit,
  projectName,
  isSubmitting = false,
}: BootstrapSessionModalProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    provider,
    model,
    setModel,
    handleProviderChange,
    modelOptions,
    loadingOpenCodeModels,
    availableProviders,
    reset: resetProviderModel,
  } = useProviderModelSelection();

  const config = getBootstrapFieldConfig(kind, mode);

  useEffect(() => {
    if (isOpen) {
      setInput('');
      setError(null);
      resetProviderModel();
    }
  }, [isOpen, kind, resetProviderModel]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (config.required && !input.trim()) {
      setError(`${config.label} to continue`);
      return;
    }
    if (provider === 'opencode' && !model) {
      setError(
        'Select an OpenCode model. If the list is empty, connect an OpenCode key in Settings → Providers.',
      );
      return;
    }

    try {
      const result = await onSubmit({ input: input.trim(), provider, model });
      if (result && !result.success) {
        setError(result.error || 'Failed to start session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start session');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={!isSubmitting ? onClose : undefined}
      />

      <div
        className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-md mx-4"
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label={config.title}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">{config.title}</h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isSubmitting}
            className="h-8 w-8 p-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="p-4 space-y-4"
        >
          {projectName && (
            <div className="text-sm text-muted-foreground">
              Project: <span className="font-medium text-foreground">{projectName}</span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300"
            >
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="bootstrap-input" className="text-sm font-medium text-foreground">
              {config.label}
              {!config.required && (
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              )}
            </label>
            <div className="flex gap-2 items-start">
              <Textarea
                ref={inputRef}
                id="bootstrap-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={config.placeholder}
                rows={6}
                disabled={isSubmitting}
                className="resize-y min-h-[120px] flex-1"
                autoFocus
              />
              <MicButton
                onTranscript={(transcript) => {
                  setInput((prev) => (prev.trim() ? prev.trimEnd() + ' ' + transcript : transcript));
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              />
            </div>
          </div>

          <ProviderModelPicker
            provider={provider}
            model={model}
            setModel={setModel}
            handleProviderChange={handleProviderChange}
            modelOptions={modelOptions}
            loadingOpenCodeModels={loadingOpenCodeModels}
            availableProviders={availableProviders}
            disabled={isSubmitting}
            testIdPrefix="bootstrap"
          />

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              className="flex-1"
              disabled={isSubmitting || (config.required && !input.trim())}
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  Starting...
                </>
              ) : (
                config.submitLabel
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default BootstrapSessionModal;
