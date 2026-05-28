import type { CustomAttribute } from './importTypes';

type AttributeEditorProps = {
  attributes: CustomAttribute[];
  emptyText: string;
  onChange: (attributes: CustomAttribute[]) => void;
  allowAdd?: boolean;
};

export function AttributeEditor({
  attributes,
  emptyText,
  onChange,
  allowAdd = true
}: AttributeEditorProps) {
  const updateAttribute = (index: number, field: keyof CustomAttribute, value: string) => {
    onChange(
      attributes.map((attribute, itemIndex) =>
        itemIndex === index ? { ...attribute, [field]: value } : attribute
      )
    );
  };

  return (
    <div className="attribute-editor">
      {attributes.map((attribute, index) => (
        <div className="custom-attribute-row" key={index}>
          <input
            value={attribute.key}
            onChange={(event) => updateAttribute(index, 'key', event.target.value)}
            placeholder="key"
          />
          <input
            value={attribute.value}
            onChange={(event) => updateAttribute(index, 'value', event.target.value)}
            placeholder="value"
          />
          <button
            className="icon-button"
            onClick={() => onChange(attributes.filter((_, itemIndex) => itemIndex !== index))}
            title="Remove attribute"
            type="button"
          >
            x
          </button>
        </div>
      ))}

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
