import { Document, Packer, Paragraph, TextRun } from 'docx';
import type { ExportDocxRequest } from '../types/api.js';

export async function buildDocxBase64(payload: ExportDocxRequest) {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: 'Title',
            children: [new TextRun({ text: payload.title, bold: true, size: 34 })]
          }),
          ...(payload.summary
            ? [
                new Paragraph({
                  children: [new TextRun({ text: payload.summary, italics: true })]
                })
              ]
            : []),
          ...payload.sections.flatMap((section) => [
            new Paragraph({
              heading: 'Heading2',
              children: [new TextRun({ text: section.heading, bold: true })]
            }),
            new Paragraph({
              children: [new TextRun(section.body)]
            })
          ])
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(document);
  return buffer.toString('base64');
}
