import ReactMarkdown from 'react-markdown';

export default function AssistantMessage({ content }) {
    return (
        <ReactMarkdown
            components={{
                p: ({ children }) => <p className="leading-relaxed [&:not(:last-child)]:mb-2">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
                ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-4">{children}</ul>,
                ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-4">{children}</ol>,
                li: ({ children }) => <li className="pl-1 leading-relaxed">{children}</li>,
            }}
        >
            {String(content || '')}
        </ReactMarkdown>
    );
}