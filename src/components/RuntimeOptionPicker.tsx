import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface RuntimeOptionItem {
  value: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

interface RuntimeOptionPickerProps {
  label: string;
  value: string | null;
  options: RuntimeOptionItem[];
  disabled?: boolean;
  loading?: boolean;
  onOpen?: () => void;
  onSelect?: (value: string) => void;
}

export default function RuntimeOptionPicker(props: RuntimeOptionPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = props.options.find((option) => option.value === props.value);

  useEffect(() => {
    if (!open) return;

    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [open]);

  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  const toggle = () => {
    if (props.disabled || !props.onSelect) return;
    const next = !open;
    setOpen(next);
    if (next) props.onOpen?.();
  };

  return (
    <div className="runtime-option-picker" ref={rootRef}>
      <button
        className="runtime-option-trigger"
        type="button"
        aria-label={`Choose ${props.label.toLowerCase()}`}
        aria-expanded={open}
        aria-busy={props.loading || undefined}
        disabled={props.disabled || !props.onSelect}
        title={`${props.label}: ${selected?.label ?? props.value ?? 'Not set'}`}
        onClick={toggle}
      >
        <span>{selected?.label ?? props.value ?? props.label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="runtime-option-menu" role="group" aria-label={`${props.label} options`}>
          {props.loading && props.options.length === 0 ? (
            <span className="runtime-option-empty">Loading...</span>
          ) : props.options.length === 0 ? (
            <span className="runtime-option-empty">No options</span>
          ) : props.options.map((option) => (
            <button
              className="runtime-option-item"
              type="button"
              aria-pressed={option.value === props.value}
              key={option.value}
              onClick={() => {
                props.onSelect?.(option.value);
                setOpen(false);
              }}
            >
              <span className="runtime-option-check">
                {option.value === props.value && <Check size={14} aria-hidden="true" />}
              </span>
              <span className="runtime-option-copy">
                <span className="runtime-option-name">
                  {option.label}
                  {option.isDefault && <span className="runtime-option-default">Default</span>}
                </span>
                {option.description && <span className="runtime-option-description">{option.description}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
