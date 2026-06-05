import { saveAs } from 'file-saver';
import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, TextRun } from 'docx';

export const exportToTXT = (content: string, filename: string) => {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  saveAs(blob, `${filename}.txt`);
};

export const exportToPDF = (content: string, filename: string) => {
  const doc = new jsPDF();
  const splitText = doc.splitTextToSize(content, 180);
  doc.text(splitText, 15, 15);
  doc.save(`${filename}.pdf`);
};

export const exportToDOCX = async (content: string, filename: string) => {
  const splitContent = content.split('\n');
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: splitContent.map((line) => {
          return new Paragraph({
            children: [new TextRun(line)],
          });
        }),
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, `${filename}.docx`);
};
