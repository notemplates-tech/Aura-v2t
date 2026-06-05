import express from "express";
import path from "path";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const uploadDir = os.tmpdir();
const upload = multer({ dest: uploadDir, limits: { fileSize: 1000 * 1024 * 1024 } }); // 1GB limit

let aiInstance: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required. Please add it via the Settings menu.");
    }
    aiInstance = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } },
    });
  }
  return aiInstance;
}

function getCleanMimeType(mimeType: string, filename: string): string {
  const clean = (mimeType || "").toLowerCase().split(";")[0].trim();
  if (clean === "audio/mpeg" || clean === "audio/mp3") return "audio/mp3";
  if (clean === "audio/wav" || clean === "audio/x-wav") return "audio/wav";
  if (clean === "audio/aac" || clean === "audio/x-aac") return "audio/aac";
  if (clean === "audio/webm") return "audio/webm";
  if (clean === "audio/m4a" || clean === "audio/x-m4a") return "audio/m4a";
  if (clean === "audio/ogg") return "audio/ogg";
  if (clean === "audio/flac") return "audio/flac";
  if (clean === "video/mp4") return "video/mp4";
  if (clean === "video/webm") return "video/webm";
  
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".mp3") return "audio/mp3";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".m4a") return "audio/m4a";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  
  return clean || "audio/mp3";
}

const CHUNKS_DIR = path.join(os.tmpdir(), "chunked-uploads");
if (!fs.existsSync(CHUNKS_DIR)) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
}

// Endpoint to upload a single chunk
app.post("/api/upload-chunk", upload.single("chunk"), async (req, res) => {
  try {
    const chunkFile = req.file;
    const { uploadId, chunkIndex } = req.body;

    if (!chunkFile) {
      return res.status(400).json({ error: "No chunk file provided" });
    }
    if (!uploadId) {
      return res.status(400).json({ error: "Missing uploadId" });
    }

    const sessionDir = path.join(CHUNKS_DIR, uploadId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const chunkPath = path.join(sessionDir, `chunk-${chunkIndex}`);
    // Move the uploaded temp file to our session directory
    fs.renameSync(chunkFile.path, chunkPath);

    return res.json({ success: true, chunkReceived: chunkIndex });
  } catch (err: any) {
    console.error("Error saving chunk:", err);
    return res.status(500).json({ error: err.message || "Failed to upload chunk" });
  }
});

// Endpoint to assemble finished upload chunks
app.post("/api/assemble-upload", async (req, res) => {
  try {
    const { uploadId, totalChunks, filename } = req.body;
    if (!uploadId || !totalChunks) {
      return res.status(400).json({ error: "Missing uploadId or totalChunks" });
    }

    const sessionDir = path.join(CHUNKS_DIR, uploadId);
    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: "Upload session not found" });
    }

    const ext = path.extname(filename || "audio.mp4") || ".mp4";
    const assembledFile = path.join(sessionDir, `assembled${ext}`);

    // Clean up previous assembled file if it exists to allow safe re-assembly
    if (fs.existsSync(assembledFile)) {
      try {
        fs.unlinkSync(assembledFile);
      } catch (err) {
        // Ignore if error occurs
      }
    }

    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(sessionDir, `chunk-${i}`);
      if (!fs.existsSync(chunkPath)) {
        return res.status(400).json({ error: `Missing chunk ${i}` });
      }
      const data = fs.readFileSync(chunkPath);
      fs.appendFileSync(assembledFile, data);
    }

    return res.json({ 
      success: true, 
      fileId: uploadId,
      mimeType: getCleanMimeType("", filename || "audio.mp4"),
      path: assembledFile,
      filename: filename || "audio.mp4"
    });
  } catch (err: any) {
    console.error("Error assembling chunks:", err);
    return res.status(500).json({ error: err.message || "Failed to assemble chunks" });
  }
});

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  let chunksDir = "";
  const cleanupDirs: string[] = [];
  try {
    const file = req.file;
    const { summaryType, customCommand, trimStart, trimEnd, driveFileIds, accessToken, fileId, originalFileName } = req.body;

    if (!file && !driveFileIds && !fileId) {
      return res.status(400).json({ error: "No media file, Google Drive chunks, or local fileId provided." });
    }

    const contentsParts: any[] = [];
    let fileToUpload = "";
    let mimeToUpload = "";

    if (fileId) {
      const sessionDir = path.join(CHUNKS_DIR, fileId);
      if (fs.existsSync(sessionDir)) {
        const filesInDir = fs.readdirSync(sessionDir);
        const assembledName = filesInDir.find(f => f.startsWith("assembled"));
        if (assembledName) {
          fileToUpload = path.join(sessionDir, assembledName);
          const origName = originalFileName || assembledName;
          mimeToUpload = getCleanMimeType("", origName);
          cleanupDirs.push(sessionDir);
        } else {
          return res.status(400).json({ error: "Assembled file not found in session." });
        }
      } else {
        return res.status(404).json({ error: "Upload session not found or expired." });
      }
    } else if (driveFileIds) {
      if (!accessToken) {
        return res.status(400).json({ error: "Access token is required to download chunks from Google Drive." });
      }
      let ids: string[] = [];
      try {
        ids = typeof driveFileIds === "string" ? JSON.parse(driveFileIds) : driveFileIds;
      } catch (parseErr) {
        return res.status(400).json({ error: "Invalid google drive chunks parameter format." });
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "Google drive chunks list is empty or invalid." });
      }

      chunksDir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
      cleanupDirs.push(chunksDir);
      const originalName = req.body.originalFileName || "audio_rejoined.mp4";
      const ext = path.extname(originalName) || ".mp4";
      fileToUpload = path.join(chunksDir, `joined${ext}`);
      mimeToUpload = req.body.originalMimeType || "audio/mp4";

      // Download and join sequentially
      for (const fileId of ids) {
        console.log(`Downloading chunk ${fileId} from Google Drive...`);
        const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        if (!fileRes.ok) {
          const detail = await fileRes.text();
          throw new Error(`Failed to download chunk ${fileId} from Drive: HTTP ${fileRes.status} - ${detail}`);
        }
        const chunkBuffer = await fileRes.arrayBuffer();
        fs.appendFileSync(fileToUpload, Buffer.from(chunkBuffer));
      }
      console.log(`Reassembled file successfully. Size: ${fs.statSync(fileToUpload).size} bytes`);
    } else if (file) {
      fileToUpload = file.path;
      mimeToUpload = getCleanMimeType(file.mimetype, file.originalname);
    }

    try {
      if ((trimStart && !isNaN(parseFloat(trimStart)) && parseFloat(trimStart) > 0) || 
          (trimEnd && !isNaN(parseFloat(trimEnd)) && parseFloat(trimEnd) > 0)) {
          
        const trimDir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-"));
        cleanupDirs.push(trimDir);
        const trimmedFile = path.join(trimDir, "trimmed.mp3");
        
        const ffmpegArgs = ['-i', fileToUpload];
        if (trimStart && !isNaN(parseFloat(trimStart)) && parseFloat(trimStart) > 0) {
          ffmpegArgs.push('-ss', String(trimStart));
        }
        if (trimEnd && !isNaN(parseFloat(trimEnd)) && parseFloat(trimEnd) > 0) {
          ffmpegArgs.push('-to', String(trimEnd));
        }
        
        ffmpegArgs.push('-vn', '-c:a', 'libmp3lame', '-q:a', '5', trimmedFile);

        await new Promise((resolve, reject) => {
          execFile(ffmpegInstaller.path, ffmpegArgs, (error, stdout, stderr) => {
            if (error) {
               console.error("FFMPEG Error:", stderr);
               reject(error);
            } else {
               resolve(true);
            }
          });
        });

        fileToUpload = trimmedFile;
        mimeToUpload = "audio/mp3";
      }
      
      const uploadRes = await getAI().files.upload({ file: fileToUpload, config: { mimeType: mimeToUpload } });
      contentsParts.push({
        fileData: { fileUri: uploadRes.uri, mimeType: uploadRes.mimeType }
      });
      
    } catch (ffmpegErr: any) {
      console.warn("FFMPEG segmentation failed, falling back to direct upload of original file:", ffmpegErr.message || ffmpegErr);
      
      // Reset parts if FFMPEG failed partially
      contentsParts.length = 0;
      
      const cleanMime = file ? getCleanMimeType(file.mimetype, file.originalname) : mimeToUpload;
      console.log(`Resilient fallback: uploading file directly with MIME type ${cleanMime}`);
      
      const uploadRes = await getAI().files.upload({
        file: file ? file.path : fileToUpload,
        config: { mimeType: cleanMime }
      });
      
      contentsParts.push({
        fileData: {
          fileUri: uploadRes.uri,
          mimeType: uploadRes.mimeType
        }
      });
    }

    let summaryInstruction = "Summarize the key points of the recorded audio/video.";
    if (customCommand && customCommand.trim()) {
      summaryInstruction = `The user issued a specific custom dynamic instruction or command for analyzing this audio: "${customCommand.trim()}". Please fulfill the user's specific instruction exactly (in appropriate markdown).`;
    } else if (summaryType === "bulletPoints") {
      summaryInstruction = "Please summarize the core message and all important points from this recording into a concise bulleted list.";
    } else if (summaryType === "actionItems") {
      summaryInstruction = "Extract a clear list of actionable items or tasks discussed in this recording.";
    } else if (summaryType === "fullTranscript") {
      summaryInstruction = "Provide a full accurate transcription of the spoken words.";
    }

    const glossary = [
      {
        "category": "Базовые концепции (Core Concepts)",
        "terms": [
          {"term": "Ци", "phonetics": ["чи", "ци", "тси"], "context": "Энергия, жизненная сила"},
          {"term": "Инь и Ян", "phonetics": ["инь ян", "инь-ян", "инь и ян"], "context": "Две противоположные энергии"},
          {"term": "У-Син", "phonetics": ["усин", "у син", "у-син"], "context": "Пять элементов (Дерево, Огонь, Земля, Металл, Вода)"},
          {"term": "Тай-цзи", "phonetics": ["тайчи", "тай чи", "тайцзи", "тай-цзи"], "context": "Великий предел, символ Инь-Ян"},
          {"term": "Дао", "phonetics": ["дао", "тао"], "context": "Путь, первооснова"},
          {"term": "Багуа", "phonetics": ["ба гуа", "багуа", "пакуа"], "context": "Восьмиугольник, 8 триграмм"},
          {"term": "Ло Шу", "phonetics": ["ло шу", "лошу"], "context": "Магический квадрат 3х3"},
          {"term": "Хэ Ту", "phonetics": ["хэ ту", "хэту", "хе ту"], "context": "Карта реки Хэ, схема элементов"}
        ]
      },
      {
        "category": "Ба Цзы - Четыре Столпа Судьбы (Ba Zi)",
        "terms": [
          {"term": "Ба Цзы", "phonetics": ["бацзы", "ба цзы", "бадзы", "ба-цзы"], "context": "Астрологическая система Четыре столпа судьбы"},
          {"term": "Тянь Гань", "phonetics": ["тянь гань", "тяньгань", "небесные стволы"], "context": "10 Небесных стволов"},
          {"term": "Ди Чжи", "phonetics": ["ди чжи", "дичжи", "земные ветви"], "context": "12 Земных ветвей (животных)"},
          {"term": "Цзя", "phonetics": ["цзя", "дзя"], "context": "Янское Дерево (ствол)"},
          {"term": "И", "phonetics": ["и"], "context": "Иньское Дерево (ствол)"},
          {"term": "Бин", "phonetics": ["бин"], "context": "Янский Огонь (ствол)"},
          {"term": "Дин", "phonetics": ["дин"], "context": "Иньский Огонь (ствол)"},
          {"term": "У", "phonetics": ["у", "ву"], "context": "Янская Земля (ствол)"},
          {"term": "Цзи", "phonetics": ["цзи", "джи"], "context": "Иньская Земля (ствол)"},
          {"term": "Гэн", "phonetics": ["гэн", "ген", "гень"], "context": "Янский Металл (ствол)"},
          {"term": "Синь", "phonetics": ["синь", "син"], "context": "Иньский Металл (ствол)"},
          {"term": "Жэнь", "phonetics": ["жэнь", "жень", "рен"], "context": "Янская Вода (ствол)"},
          {"term": "Гуй", "phonetics": ["гуй", "гвей", "квей"], "context": "Иньская Вода (ствол)"},
          {"term": "Цзы", "phonetics": ["цзы", "дзы"], "context": "Крыса (ветвь)"},
          {"term": "Чоу", "phonetics": ["чоу", "чо"], "context": "Бык (ветвь)"},
          {"term": "Инь", "phonetics": ["инь"], "context": "Тигр (ветвь)"},
          {"term": "Мао", "phonetics": ["мао"], "context": "Кролик (ветвь)"},
          {"term": "Чэнь", "phonetics": ["чэнь", "чень", "чен"], "context": "Дракон (ветвь)"},
          {"term": "Сы", "phonetics": ["сы", "си"], "context": "Змея (ветвь)"},
          {"term": "У", "phonetics": ["у", "ву"], "context": "Лошадь (ветвь)"},
          {"term": "Вэй", "phonetics": ["вэй", "вей"], "context": "Коза (ветвь)"},
          {"term": "Шэнь", "phonetics": ["шэнь", "шень", "шен"], "context": "Обезьяна (ветвь)"},
          {"term": "Ю", "phonetics": ["ю"], "context": "Петух (ветвь)"},
          {"term": "Сюй", "phonetics": ["сюй", "суй"], "context": "Собака (ветвь)"},
          {"term": "Хай", "phonetics": ["хай"], "context": "Свинья (ветвь)"},
          {"term": "Ши Шэнь", "phonetics": ["ши шэнь", "шишень", "10 богов", "десять богов"], "context": "Система 10 божеств в Ба Цзы"},
          {"term": "Ци Ша", "phonetics": ["ци ша", "циша", "чи ша", "седьмой убийца", "убийца на 7 позиции"], "context": "7 убийца (божество)"},
          {"term": "Шан Гуань", "phonetics": ["шан гуань", "шангуань", "вызов власти"], "context": "Вызов власти (божество)"},
          {"term": "Пянь Цай", "phonetics": ["пянь цай", "пяньцай", "склонность к богатству", "косое богатство"], "context": "Склонность к богатству (божество)"},
          {"term": "Чжэн Цай", "phonetics": ["чжэн цай", "чжен цай", "прямое богатство"], "context": "Прямое богатство (божество)"},
          {"term": "Чжэн Инь", "phonetics": ["чжэн инь", "чжен инь", "правильная печать", "прямая ресурсоемкость"], "context": "Правильная печать (божество)"},
          {"term": "Пянь Инь", "phonetics": ["пянь инь", "косая печать", "дух совы"], "context": "Косая печать (божество)"},
          {"term": "Би Цзянь", "phonetics": ["би цзянь", "бицзянь", "би дзянь", "братство"], "context": "Братство / Равное плечо (божество)"},
          {"term": "Цзе Цай", "phonetics": ["цзе цай", "цзецай", "дзие цай", "грабитель богатства"], "context": "Грабитель богатства (божество)"},
          {"term": "Кун Ван", "phonetics": ["кун ван", "кунван", "пустота"], "context": "Демон Пустоты"}
        ]
      },
      {
        "category": "Фэн Шуй (Feng Shui)",
        "terms": [
          {"term": "Фэн-шуй", "phonetics": ["феншуй", "фэн шуй", "фен шуй"], "context": "Искусство гармонизации пространства"},
          {"term": "Сань Хэ", "phonetics": ["сань хэ", "саньхэ", "сан хе"], "context": "Школа Трех Гармоний"},
          {"term": "Сань Юань", "phonetics": ["сань юань", "саньюань", "сан юан"], "context": "Школа Трех Эпох (Летящие звезды)"},
          {"term": "Фэй Син", "phonetics": ["фэй син", "фей син", "летящие звезды"], "context": "Техника Летящих звезд"},
          {"term": "Лопань", "phonetics": ["лопань", "ло пань", "компас лопань"], "context": "Геомантический компас"},
          {"term": "Ша Ци", "phonetics": ["ша ци", "шаци", "ша чи"], "context": "Убивающая, негативная энергия"},
          {"term": "Шэн Ци", "phonetics": ["шэн ци", "шэнци", "шен чи"], "context": "Благотворная, растущая энергия"},
          {"term": "Тай Суй", "phonetics": ["тай суй", "тайсуй", "князь года"], "context": "Князь года (аффликция)"},
          {"term": "Суй По", "phonetics": ["суй по", "суйпо", "разрушитель года"], "context": "Разрушитель года (аффликция)"},
          {"term": "Сань Ша", "phonetics": ["сань ша", "сан ша", "три ша"], "context": "Три убийцы (аффликция)"},
          {"term": "У Хуан", "phonetics": ["у хуан", "ухуан", "желтая пятерка", "звезда 5"], "context": "Звезда 5 Желтая (негативная)"}
        ]
      },
      {
        "category": "Ци Мэнь Дун Цзя (Qi Men Dun Jia)",
        "terms": [
          {"term": "Ци Мэнь Дун Цзя", "phonetics": ["цимень", "ци мэнь", "ци мень дун цзя", "чи мен дун дзя", "цимень дунь цзя"], "context": "Искусство мистических врат"},
          {"term": "Врата (Ба Мэнь)", "phonetics": ["врата", "ба мэнь", "восемь врат"], "context": "8 Врат человеческого фактора"},
          {"term": "Сю Мэнь", "phonetics": ["сю мэнь", "сюмень", "врата отдыха"], "context": "Врата Отдыха"},
          {"term": "Шэн Мэнь", "phonetics": ["шэн мэнь", "шэнмень", "шен мен", "врата жизни"], "context": "Врата Жизни"},
          {"term": "Шан Мэнь", "phonetics": ["шан мэнь", "шанмень", "врата ранения"], "context": "Врата Ранения"},
          {"term": "Ду Мэнь", "phonetics": ["ду мэнь", "думень", "врата тайника", "врата непроходимости"], "context": "Врата Тайника"},
          {"term": "Цзин Мэнь (Великолепие)", "phonetics": ["цзин мэнь", "цзинмень", "джин мен", "врата сцены", "врата великолепия"], "context": "Врата Сцены (Огонь)"},
          {"term": "Сы Мэнь", "phonetics": ["сы мэнь", "сымень", "си мен", "врата смерти"], "context": "Врата Смерти"},
          {"term": "Цзин Мэнь (Шок)", "phonetics": ["цзин мэнь", "цзинмень", "джин мен", "врата испуга", "врата шока"], "context": "Врата Испуга (Металл)"},
          {"term": "Кай Мэнь", "phonetics": ["кай мэнь", "каймень", "врата открытия"], "context": "Врата Открытия"},
          {"term": "Духи (Шэнь)", "phonetics": ["духи", "божества цимень", "ба шэнь"], "context": "8 Божеств/Духов"},
          {"term": "Чжи Фу", "phonetics": ["чжи фу", "чжифу", "джи фу", "главный дух"], "context": "Главный Дух"},
          {"term": "Тэн Шэ", "phonetics": ["тэн шэ", "тэншэ", "тен ше", "пернатый змей", "змея"], "context": "Дух Змея"},
          {"term": "Тай Инь", "phonetics": ["тай инь", "тайинь", "луна"], "context": "Дух Луны (Великий Инь)"},
          {"term": "Лю Хэ", "phonetics": ["лю хэ", "люхэ", "шесть гармоний"], "context": "Дух 6 Гармоний"},
          {"term": "Бай Ху", "phonetics": ["бай ху", "байху", "белый тигр"], "context": "Дух Белого Тигра"},
          {"term": "Сюань У", "phonetics": ["сюань у", "сюаньу", "черная черепаха", "темный воин"], "context": "Дух Черепахи (Темный Воин)"},
          {"term": "Цзю Ди", "phonetics": ["цзю ди", "цзюди", "девять земель"], "context": "Дух 9 Земель"},
          {"term": "Цзю Тянь", "phonetics": ["цзю тянь", "цзютянь", "девять небес"], "context": "Дух 9 Небес"},
          {"term": "Звезды (Цзю Син)", "phonetics": ["звезды", "цзю син", "девять звезд"], "context": "9 Звезд Небесного фактора"},
          {"term": "Тянь Пэн", "phonetics": ["тянь пэн", "тяньпэн", "тен пен", "звезда трава"], "context": "Звезда Трава / Пэн"},
          {"term": "Тянь Жуй", "phonetics": ["тянь жуй", "тяньжуй", "тен жуй", "звезда болезнь"], "context": "Звезда Болезнь / Жуй"},
          {"term": "Тянь Чун", "phonetics": ["тянь чун", "тяньчун", "тен чун", "звезда агрессор"], "context": "Звезда Агрессор / Чун"},
          {"term": "Тянь Фу", "phonetics": ["тянь фу", "тяньфу", "тен фу", "звезда помощник"], "context": "Звезда Помощник / Фу"},
          {"term": "Тянь Ин", "phonetics": ["тянь ин", "тянь инь", "тяньин", "тен ин", "звезда герой"], "context": "Звезда Герой / Ин"},
          {"term": "Тянь Цинь", "phonetics": ["тянь цинь", "тяньцинь", "тен чин", "звезда птица"], "context": "Звезда Птица / Цинь"},
          {"term": "Тянь Чжу", "phonetics": ["тянь чжу", "тяньчжу", "тен джу", "звезда столб"], "context": "Звезда Столб / Чжу"},
          {"term": "Тянь Синь", "phonetics": ["тянь синь", "тяньсинь", "тен син", "звезда сердце"], "context": "Звезда Сердце / Синь"},
          {"term": "Тянь Жэнь", "phonetics": ["тянь жэнь", "тяньжэнь", "тен жень", "звезда чиновник"], "context": "Звезда Чиновник / Жэнь"}
        ]
      }
    ];

    const textPart = {
      text: `First, provide a full transcript of the provided audio parts (they are sequential pieces of a larger recording). Since the audio may contain single or multiple speakers, you MUST perform speaker diarization with approximate timestamps: detect and distinguish different speakers in the recording, labeling them consistently (e.g., 'Спикер 1:', 'Спикер 2:', etc.) in Russian, and attribute their respective spoken lines in the transcript. Group consecutive lines by the same speaker together. For each speaker turn, you MUST prepend an accurate/approximate timestamp in the format '[MM:SS]' (e.g., '[00:04] Спикер 1:', '[01:15] Спикер 2:') designating the approximate start time or elapsed time of that turn based on the audio content. Ensure there is a space after the timestamp before the speaker label.
Then, perform deep sentiment analysis on the transcript. State whether the emotion/vibe is positive, neutral, or negative, and choose an exact sentiment score from -1.0 to +1.0.
Then, based on the following instruction, provide the requested short summary / insights in Russian language (unless explicitly requested otherwise in the instruction): ${summaryInstruction}
Then, perform a high-fidelity detailed analytical breakdown of the content, including structural headings, thorough explanation of the discussion, main takeaways, key semantic tags, speaker dynamics, and core action items (this must be a verbose breakdown of the entire recording, styled in clean, professional markdown in Russian language). Include approximate timestamps (e.g., '[01:23]') where relevant to facilitate reference.

*CRITICAL TERMINOLOGY DICTIONARY*: If the audio relates to Chinese Metaphysics (Ba Zi, Feng Shui, Qi Men Dun Jia), USE THE FOLLOWING GLOSSARY dictating exactly how specific terms should be spelled. If you hear something sounding like the "phonetics", always transcribe it as the designated "term".
Glossary Reference: \n${JSON.stringify(glossary, null, 2)}

You must return ONLY a JSON object with this EXACT schema (do not wrap in markdown code blocks like \`\`\`json):
{
  "transcript": "The full raw transcription of the spoken words, with speaker diarization and Russian timestamps prepended (e.g., '[00:04] Спикер 1:', '[01:15] Спикер 2:'), cleaned and corrected using the terminology dictionary.",
  "summary": "The requested short summary / insights styled in clean markdown in Russian.",
  "detailedAnalysis": "The high-fidelity, detailed analytical, structured markdown breakdown covering the entire recording's main topics, takeaways, key vocabulary, and analytical insights in Russian.",
  "result": "The combined markdown containing the summary first, followed by the full transcript (retaining the Russian speaker diarization labels and timestamps).",
  "tags": ["keyword1", "keyword2"], // Array of up to 10 relevant keywords extracted from the content in Russian
  "detectedLanguage": "ISO 639-1 code of the detected spoken language (e.g., 'en', 'ru')",
  "sentiment": {
    "score": 0.0, // A numeric value representing sentiment, from -1.0 (extremely negative/disappointed) to +1.0 (extremely positive/supportive), or 0.0 for neutral.
    "label": "positive", // Exactly one of: "positive", "neutral", "negative".
    "emoji": "😊", // A highly fitting single emoji representing the tone and emotions (e.g., 😊, 🎉, 😐, 😢, 🔥, 😡, etc.)
    "explanation": "A concise 1-sentence analysis in Russian explaining the tone and score chosen."
  }
}`
    };

    const transcribeSchema = {
      type: Type.OBJECT,
      properties: {
        transcript: {
          type: Type.STRING,
          description: "The full raw transcription of the spoken words, with speaker diarization and Russian timestamps prepended (e.g., '[00:04] Спикер 1:', '[01:15] Спикер 2:'), cleaned and corrected using the terminology dictionary.",
        },
        summary: {
          type: Type.STRING,
          description: "The requested short summary / insights styled in clean markdown in Russian.",
        },
        detailedAnalysis: {
          type: Type.STRING,
          description: "The high-fidelity, detailed analytical, structured markdown breakdown covering the entire recording's main topics, takeaways, key vocabulary, and analytical insights in Russian.",
        },
        result: {
          type: Type.STRING,
          description: "The combined markdown containing the summary first, followed by the full transcript (retaining the Russian speaker diarization labels and timestamps).",
        },
        tags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Array of up to 10 relevant keywords extracted from the content in Russian.",
        },
        detectedLanguage: {
          type: Type.STRING,
          description: "ISO 639-1 code of the detected spoken language (e.g., 'en', 'ru').",
        },
        sentiment: {
          type: Type.OBJECT,
          properties: {
            score: {
              type: Type.NUMBER,
              description: "A numeric value representing sentiment, from -1.0 to +1.0.",
            },
            label: {
              type: Type.STRING,
              description: "Exactly one of: 'positive', 'neutral', 'negative'.",
            },
            emoji: {
              type: Type.STRING,
              description: "A highly fitting single emoji representing the tone and emotions.",
            },
            explanation: {
              type: Type.STRING,
              description: "A concise 1-sentence analysis in Russian explaining the tone and score chosen.",
            }
          },
          required: ["score", "label", "emoji", "explanation"]
        }
      },
      required: ["transcript", "summary", "detailedAnalysis", "result", "tags", "detectedLanguage", "sentiment"]
    };

    let response;
    const modelsToTry = [
      "gemini-3.1-flash-lite",
      "gemini-flash-latest",
      "gemini-3.5-flash"
    ];
    let lastError: any = null;

    for (const model of modelsToTry) {
      try {
        console.log(`Attempting transcription with model: ${model}...`);
        response = await getAI().models.generateContent({
          model: model,
          contents: { parts: [...contentsParts, textPart] },
          config: {
            responseMimeType: "application/json",
            responseSchema: transcribeSchema
          }
        });
        if (response) {
          console.log(`Successfully completed transcription using ${model}!`);
          break;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`Model ${model} transcription failed or returned an error:`, err.message || err);
      }
    }

    if (!response) {
      throw lastError || new Error("All transcription models failed or are currently unavailable due to high demand. Please try again later.");
    }

    let responseText = "";
    try {
      responseText = response.text ? response.text.trim() : "";
    } catch (textErr: any) {
      console.warn("Error reading response.text property:", textErr.message || textErr);
      responseText = JSON.stringify(response) || "";
    }

    // Attempt robust JSON parsing
    let parsedData: any = null;
    let cleanText = responseText;

    if (cleanText) {
      if (cleanText.startsWith("```")) {
        const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) {
          cleanText = match[1].trim();
        }
      }

      try {
        parsedData = JSON.parse(cleanText);
      } catch (parseErr: any) {
        console.warn("Standard JSON.parse failed. Retrying with bracket matching:", parseErr.message || parseErr);
        const openBrace = cleanText.indexOf('{');
        const closeBrace = cleanText.lastIndexOf('}');
        if (openBrace !== -1 && closeBrace !== -1 && closeBrace > openBrace) {
          try {
            const potentialJson = cleanText.substring(openBrace, closeBrace + 1);
            parsedData = JSON.parse(potentialJson);
          } catch (innerErr: any) {
            console.error("Bracket matching JSON.parse failed:", innerErr.message || innerErr);
          }
        }
      }
    }

    if (parsedData && typeof parsedData === "object" && !Array.isArray(parsedData)) {
      // Return successfully parsed JSON object
      res.json(parsedData);
    } else {
      console.warn("Could not parse response as structured JSON object. Returning fallback formatted JSON.");
      // Ensure the client receives valid, correct JSON structure with all expected fields
      res.json({
        result: responseText,
        transcript: responseText,
        summary: "Ошибка форматирования ответа ИИ. Ниже предоставлен полный текст.",
        detailedAnalysis: responseText,
        tags: [],
        detectedLanguage: "ru",
        sentiment: {
          score: 0.0,
          label: "neutral",
          emoji: "😐",
          explanation: "Не удалось проанализировать чувства."
        }
      });
    }
  } catch (err: any) {
    console.error("Transcribe API Error:", err);
    res.status(500).json({ error: err.message || "An error occurred during transcription." });
  } finally {
    // Cleanup local files
    if (req.file) fs.unlink(req.file.path, () => {});
    for (const dir of cleanupDirs) {
      if (dir) {
        fs.rm(dir, { recursive: true, force: true }, () => {});
      }
    }
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Global error handler:", err);
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
