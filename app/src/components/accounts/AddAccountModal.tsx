import { PROVIDERS, type ProviderDescriptor } from '../../types/accounts';

interface AddAccountModalProps {
  open: boolean;
  onClose: () => void;
  onPick: (provider: ProviderDescriptor) => void;
}

const AddAccountModal = ({ open, onClose, onPick }: AddAccountModalProps) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}>
      <div
        className="w-[420px] max-w-[90vw] rounded-2xl bg-white p-6 shadow-strong"
        onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-900">Add account</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-stone-500 hover:bg-stone-100"
            aria-label="close">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mb-4 text-sm text-stone-500">
          Open a service inside the app and stream its conversations into your memory.
        </p>

        <div className="space-y-2">
          {PROVIDERS.map(p => (
            <button
              key={p.id}
              onClick={() => onPick(p)}
              className="flex w-full items-start gap-3 rounded-lg border border-stone-200 p-3 text-left transition-colors hover:border-primary-300 hover:bg-primary-50">
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-stone-100 text-base font-semibold text-stone-700">
                {p.label.charAt(0)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-stone-900">{p.label}</div>
                <div className="text-xs text-stone-500">{p.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AddAccountModal;
