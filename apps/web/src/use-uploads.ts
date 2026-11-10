import { useRef, useState } from "react";
import { api } from "./api.ts";

export interface UploadAttachment { path: string; name: string; image: boolean }
const MAX_ATTACHMENTS = 20;
const MAX_IMAGES = 8;

// CAD 的 image/vnd.dwg、image/vnd.dxf 不是视觉模型可读取的图片。
export const isVisionImage = (file: Pick<File, "name" | "type">) =>
  /\.(png|jpe?g|gif|webp)$/i.test(file.name) || /^image\/(png|jpeg|gif|webp)$/i.test(file.type);

export function attachmentText(text: string, files: UploadAttachment[]) {
  return [text.trim(), ...files.map((f) => `[附件] ${f.path}`)].filter(Boolean).join("\n");
}

/** 上传完成后独立保存附件，不依赖可编辑的输入框内容。 */
export function useUploads(onError: (message: string) => void) {
  const [files, setFiles] = useState<UploadAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const current = useRef<UploadAttachment[]>([]);
  const pending = useRef(0);
  const update = (next: UploadAttachment[]) => { current.current = next; setFiles(next); };
  const upload = async (selected: File[]) => {
    pending.current++;
    setUploading(true);
    try {
      for (const file of selected) {
        try {
          if (file.size > 100 * 1024 * 1024) throw new Error("文件超过 100MiB");
          if (current.current.length >= MAX_ATTACHMENTS) throw new Error(`每次最多上传 ${MAX_ATTACHMENTS} 个附件`);
          const image = isVisionImage(file);
          if (image && current.current.filter((f) => f.image).length >= MAX_IMAGES) throw new Error(`每次最多上传 ${MAX_IMAGES} 张图片`);
          const result = await api.upload(file);
          update([...current.current, { path: result.path, name: result.path.split("/").pop()!, image }]);
        } catch (error) { onError(`${file.name}：${(error as Error).message}`); }
      }
    } finally {
      pending.current--;
      setUploading(pending.current > 0);
    }
  };
  return { files, uploading, upload, isUploading: () => pending.current > 0,
    remove: (filePath: string) => update(current.current.filter((f) => f.path !== filePath)),
    clear: () => update([]),
  };
}
