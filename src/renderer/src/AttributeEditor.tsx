import type { CustomAttribute } from './importTypes';

type AttributeEditorProps = {
  attributes: CustomAttribute[];
  emptyText: string;
  onChange: (attributes: CustomAttribute[]) => void;
  allowAdd?: boolean;
  requiredKeys?: string[];
};

export function ensureRequiredAttributes(
  attributes: CustomAttribute[],
  requiredKeys: string[]
): CustomAttribute[] {
  const existing = new Set(attributes.map((attribute) => attribute.key.trim().toLowerCase()));
  const missing = requiredKeys
    .filter((key) => !existing.has(key.toLowerCase()))
    .map((key) => ({ key, value: '' }));
  return missing.length > 0 ? [...missing, ...attributes] : attributes;
}

export function hasRequiredAttributes(
  attributes: CustomAttribute[],
  requiredKeys: string[]
): boolean {
  return requiredKeys.every((key) => {
    const match = attributes.find((attribute) => attribute.key.trim().toLowerCase() === key.toLowerCase());
    return Boolean(match && match.value.trim());
  });
}

export function AttributeEditor({
  attributes,
  emptyText,
  onChange,
  allowAdd = true,
  requiredKeys = []
}: AttributeEditorProps) {
  const requiredKeySet = new Set(requiredKeys.map((key) => key.toLowerCase()));
  const isRequired = (key: string) => requiredKeySet.has(key.trim().toLowerCase());

  const updateAttribute = (index: number, field: keyof CustomAttribute, value: string) => {
    onChange(
      attributes.map((attribute, itemIndex) =>
        itemIndex === index ? { ...attribute, [field]: value } : attribute
      )
    );
  };

  return (
    <div className="attribute-editor">
      {attributes.map((attribute, index) => {
        const required = isRequired(attribute.key);
        const missing = required && !attribute.value.trim();
        return (
          <div className="custom-attribute-row" key={index}>
            <input
              disabled={required}
              value={attribute.key}
              onChange={(event) => updateAttribute(index, 'key', event.target.value)}
              placeholder="key"
            />
            <input
              className={missing ? 'required-missing' : ''}
              value={attribute.value}
              onChange={(event) => updateAttribute(index, 'value', event.target.value)}
              placeholder={required ? 'required' : 'value'}
            />
            {required ? (
              <span className="required-indicator" title="Required">*</span>
            ) : (
              <button
                className="icon-button"
                onClick={() => onChange(attributes.filter((_, itemIndex) => itemIndex !== index))}
                title="Remove attribute"
                type="button"
              >
                x
              </button>
            )}
          </div>
        );
      })}

      {attributes.length === 0 ? <div className="muted-text">{emptyText}</div> : null}

      {allowAdd ? (
        <button
          className="small-button add-row-button"
          onClick={() => onChange([...attributes, { key: '', value: '' }])}
          type="button"
        >
          Add
        </button>
      ) : null}
    </div>
  );
}
