import type { FlagSchema, FormValues } from "../engine/buildArgsArray";

interface FieldProps {
    flag: FlagSchema;
    formValues: FormValues;
    onChange: (flagName: string, value: unknown) => void;
}

export function FileField({ flag, formValues, onChange }: FieldProps) {
    const value = (formValues[flag.flag] as string) || "";
    return (
        <div className="field">
            <label>
                {flag.label} {flag.required && <span className="required">*</span>}
            </label>
            <input
                type="file"
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Browser file inputs don't expose a real absolute path; in the real Electron/
                    // Node backend this would come from a native file picker. Using the filename
                    // here as a stand-in so the UI is exercisable end-to-end.
                    if (file) onChange(flag.flag, file.name);
                }}
            />
            <span className="file-status">{value ? value : "No file selected"}</span>
            {flag.plainEnglish && <p className="hint">{flag.plainEnglish}</p>}
        </div>
    );
}

export function BooleanField({ flag, formValues, onChange }: FieldProps) {
    const value = !!formValues[flag.flag];
    return (
        <div className="field field-boolean">
            <label>
                <input
                    type="checkbox"
                    checked={value}
                    onChange={(e) => onChange(flag.flag, e.target.checked)}
                />
                {flag.label}
            </label>
            {flag.plainEnglish && <p className="hint">{flag.plainEnglish}</p>}
        </div>
    );
}

export function EnumField({ flag, formValues, onChange }: FieldProps) {
    const value = (formValues[flag.flag] as string) ?? flag.default;
    const options = flag.enum ?? [];
    const labels = flag.enumLabels ?? options;

    return (
        <div className="field">
            <label>{flag.label}</label>
            <select value={value} onChange={(e) => onChange(flag.flag, e.target.value)}>
                {options.map((opt, i) => (
                    <option key={opt} value={opt}>
                        {labels[i] ?? opt}
                    </option>
                ))}
            </select>
            {flag.plainEnglish && <p className="hint">{flag.plainEnglish}</p>}
        </div>
    );
}

export function NumberField({ flag, formValues, onChange }: FieldProps) {
    const [min, max] = flag.range ?? [-Infinity, Infinity];

    // Case: optional number (checkbox + disabled input)
    if (flag.optional) {
        const raw = formValues[flag.flag] as { value: number; enabled: boolean } | undefined;
        const current = raw ?? { value: flag.default ?? 0, enabled: !!flag.enabled };
        return (
            <div className="field field-optional-number">
                <label>
                    <input
                        type="checkbox"
                        checked={current.enabled}
                        onChange={(e) =>
                            onChange(flag.flag, { value: current.value, enabled: e.target.checked })
                        }
                    />
                    {flag.label}
                </label>
                <input
                    type="number"
                    min={min}
                    max={max}
                    disabled={!current.enabled}
                    value={current.value === undefined ? "" : String(current.value)}
                    onChange={(e) => {
                        const num = Math.min(max, Math.max(min, Number(e.target.value)));
                        onChange(flag.flag, { value: num, enabled: current.enabled });
                    }}
                />
                {flag.plainEnglish && <p className="hint">{flag.plainEnglish}</p>}
            </div>
        );
    }

    // Case: non-optional number with an unsetSentinel (currently only -crf) — reactive-only
    // disabled state, no direct control of its own. See milestone-1b-spec.md section 3.
    const value = formValues[flag.flag];
    if (flag.unsetSentinel !== undefined && value === flag.unsetSentinel) {
        return (
            <div className="field field-number-disabled">
                <label>{flag.label}</label>
                <input type="number" disabled value="" placeholder="—" />
                <p className="hint disabled-note">Disabled — using Simple Quality instead.</p>
            </div>
        );
    }

    // Case: plain non-optional number, hard-clamped
    const numValue = (value as number) ?? flag.default ?? 0;
    return (
        <div className="field">
            <label>{flag.label}</label>
            <input
                type="number"
                min={min}
                max={max}
                value={numValue}
                onChange={(e) => {
                    const num = Math.min(max, Math.max(min, Number(e.target.value)));
                    onChange(flag.flag, num);
                }}
            />
            {flag.plainEnglish && <p className="hint">{flag.plainEnglish}</p>}
        </div>
    );
}

export function StringField({ flag, formValues, onChange }: FieldProps) {
    const committedValue = (formValues[flag.flag] as string) ?? flag.default ?? "";
    return (
        <div className="field">
            <label>
                {flag.label} {flag.required && <span className="required">*</span>}
            </label>
            <input
                type="text"
                defaultValue={committedValue}
                key={committedValue} // resets the uncontrolled input if formValues changes externally (e.g. preset)
                onBlur={(e) => {
                    const pattern = flag.validation?.pattern;
                    if (pattern && !new RegExp(pattern).test(e.target.value)) {
                        e.target.classList.add("invalid");
                        return; // invalid input never gets committed to formValues
                    }
                    e.target.classList.remove("invalid");
                    onChange(flag.flag, e.target.value);
                }}
            />
            {flag.plainEnglish && <p className="hint">{flag.plainEnglish}</p>}
        </div>
    );
}

export function FieldRenderer(props: FieldProps) {
    const { flag } = props;
    // Positional flags (currently only `output`) are always string-shaped in this schema —
    // routed to StringField rather than a separate component, so the commit-on-blur and
    // pattern-validation contract (including output's leading-dash-blocking pattern) has
    // exactly one implementation instead of two that can silently drift apart.
    if (flag.kind === "positional") return <StringField {...props} />;
    switch (flag.type) {
        case "file":
            return <FileField {...props} />;
        case "boolean":
            return <BooleanField {...props} />;
        case "enum":
            return <EnumField {...props} />;
        case "number":
            return <NumberField {...props} />;
        case "string":
            return <StringField {...props} />;
        default:
            return null;
    }
}