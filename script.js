const OUTPUT_MAX_SIDE = 2600;

const MODE_LABELS = {
  plain: "Text only",
  inside: "QR inside the picture",
  like: "Looks like the picture"
};

const SIZE_HINTS = {
  locked: "Add a picture to choose small or medium.",
  inside: {
    small: "A small code woven into the picture, about two fifths of its shorter side.",
    medium: "A larger code, about two thirds of the picture’s shorter side."
  },
  like: {
    small: "The picture sits in the middle of the code, with the plain dot pattern around it.",
    medium: "The picture fills the whole code, cropped to a square."
  }
};

const STATUS = {
  plain: "Code ready. Add a picture to weave the code into it.",
  inside: "The code is woven into the picture. Show or print it large enough that the code is at least 5 cm across.",
  like: "The whole picture is the code. Show or print it large: aim for at least 10 cm across when scanning."
};

class PictureQR {
  constructor() {
    this.picture = null;
    this.pictureName = "";
    this.loadToken = 0;
    this.timer = 0;
    this.lastStyle = "plain";
    this.canvas = document.getElementById("qrCanvas");
    this.ctx = this.canvas.getContext("2d");
    qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
    this.bind();
    this.syncPictureOptions();
  }

  bind() {
    const text = document.getElementById("textInput");
    text.addEventListener("input", () => this.schedule());
    document.getElementById("generateBtn").addEventListener("click", () => {
      clearTimeout(this.timer);
      this.render(true);
    });
    document.getElementById("downloadBtn").addEventListener("click", () => this.download());

    document.querySelectorAll("#pictureOptions input, #pictureOptions select").forEach((input) => {
      input.addEventListener("change", () => {
        this.syncPictureOptions();
        if (this.text().trim()) this.render(false);
      });
    });

    const fileInput = document.getElementById("fileInput");
    const dropzone = document.getElementById("dropzone");
    const openPicker = () => fileInput.click();
    document.getElementById("browseBtn").addEventListener("click", openPicker);
    dropzone.addEventListener("click", openPicker);
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPicker();
      }
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (file) this.loadFile(file);
    });
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-over");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-over");
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) this.loadFile(file);
    });
    dropzone.tabIndex = 0;

    document.getElementById("sampleBtn").addEventListener("click", () => this.useSample());
    document.getElementById("removeBtn").addEventListener("click", () => this.clearPicture());
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(false), 250);
  }

  text() {
    return document.getElementById("textInput").value;
  }

  choice(name, fallback) {
    const selected = document.querySelector(`input[name="${name}"]:checked`);
    return selected ? selected.value : fallback;
  }

  size() {
    return this.choice("size", "small");
  }

  ink() {
    return this.choice("ink", "mono");
  }

  position() {
    return document.getElementById("position").value || "center";
  }

  style() {
    if (!this.picture) return "plain";
    return this.choice("style", "inside");
  }

  syncPictureOptions() {
    const locked = !this.picture;
    document.getElementById("pictureOptions").classList.toggle("is-locked", locked);
    document.querySelectorAll("#pictureOptions input, #pictureOptions select").forEach((input) => {
      input.disabled = locked;
    });
    const style = locked ? "locked" : this.style();
    const hint = style === "locked" ? SIZE_HINTS.locked : SIZE_HINTS[style][this.size()];
    document.getElementById("sizeHint").textContent = hint;
    document.getElementById("positionField").hidden = style !== "inside";
  }

  setStatus(message, isError) {
    const status = document.getElementById("status");
    status.textContent = message;
    status.classList.toggle("is-error", Boolean(isError));
  }

  async loadFile(file) {
    if (!file.type.startsWith("image/")) {
      this.setStatus("That file is not an image. Use a PNG, JPG, or WEBP.", true);
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      this.setStatus("That picture is larger than 12 MB. Try a smaller one.", true);
      return;
    }
    const token = ++this.loadToken;
    try {
      const image = await loadImageFile(file);
      if (token !== this.loadToken) {
        releasePicture(image);
        return;
      }
      this.releasePicture();
      this.picture = image;
      this.pictureName = file.name;
      this.showPicture();
      if (this.text().trim()) this.render(false);
      else this.setStatus("Picture ready. Add a link or some text.", false);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.setStatus("Could not read that picture. Try a PNG or JPG.", true);
    }
  }

  useSample() {
    this.loadToken += 1;
    this.releasePicture();
    this.picture = createSamplePicture();
    this.pictureName = "Sample picture";
    this.showPicture();
    if (this.text().trim()) this.render(false);
    else this.setStatus("Sample picture ready. Add a link or some text.", false);
  }

  clearPicture() {
    this.loadToken += 1;
    this.releasePicture();
    this.picture = null;
    this.pictureName = "";
    this.showPicture();
    if (this.text().trim()) this.render(false);
  }

  releasePicture() {
    releasePicture(this.picture);
  }

  showPicture() {
    const filled = document.getElementById("dropFilled");
    const empty = document.getElementById("dropEmpty");
    const remove = document.getElementById("removeBtn");
    if (!this.picture) {
      filled.hidden = true;
      empty.hidden = false;
      remove.hidden = true;
      this.syncPictureOptions();
      return;
    }
    empty.hidden = true;
    filled.hidden = false;
    remove.hidden = false;
    document.getElementById("fileName").textContent = this.pictureName;
    document.getElementById("thumb").src = sourceUrl(this.picture);
    this.syncPictureOptions();
  }

  render(fromUser) {
    if (typeof qrcode !== "function" || typeof HalftoneQR !== "object") {
      this.setStatus("The QR engine did not load. Refresh the page.", true);
      return;
    }
    const text = this.text().trim();
    if (!text) {
      this.clearPreview();
      this.setStatus(fromUser ? "Enter a link or some text." : "", Boolean(fromUser));
      return;
    }

    const style = this.style();
    const size = this.size();
    let meta;
    try {
      if (style === "plain") {
        meta = this.drawPlain(text);
      } else {
        meta = this.drawHalftone(text, style, size);
      }
    } catch (error) {
      this.clearPreview();
      this.setStatus("That text is too long to encode. Try a shorter link or message.", true);
      return;
    }

    this.lastStyle = style;
    this.canvas.hidden = false;
    document.getElementById("empty").hidden = true;
    document.getElementById("stage").classList.add("has-code");
    document.getElementById("downloadBtn").disabled = false;
    document.getElementById("previewMeta").textContent = meta;
    document.getElementById("encoded").textContent = text;
    this.setStatus(STATUS[style], false);
  }

  clearPreview() {
    this.canvas.hidden = true;
    document.getElementById("empty").hidden = false;
    document.getElementById("stage").classList.remove("has-code");
    document.getElementById("downloadBtn").disabled = true;
    document.getElementById("previewMeta").textContent = "Waiting for text";
    document.getElementById("encoded").textContent = "";
  }

  drawPlain(text) {
    const code = qrcode(0, "M");
    code.addData(text);
    code.make();
    const count = code.getModuleCount();
    const cell = Math.max(6, Math.round(860 / (count + 8)));
    const margin = 4;
    const pixels = (count + margin * 2) * cell;
    this.canvas.width = pixels;
    this.canvas.height = pixels;
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pixels, pixels);
    ctx.fillStyle = "#111111";
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (code.isDark(row, col)) {
          ctx.fillRect((col + margin) * cell, (row + margin) * cell, cell, cell);
        }
      }
    }
    return `${MODE_LABELS.plain} · ${count} × ${count} modules`;
  }

  drawHalftone(text, style, size) {
    const picture = this.picture;
    const width = picture.naturalWidth || picture.width;
    const height = picture.naturalHeight || picture.height;
    const result = HalftoneQR.render({
      qrcode,
      text,
      style,
      size,
      position: this.position(),
      ink: this.ink(),
      aspect: width / height,
      sample: makeSampler(picture)
    });

    const rgba = HalftoneQR.toRGBA(result);
    const scale = HalftoneQR.suggestedScale(result, OUTPUT_MAX_SIDE);
    const small = document.createElement("canvas");
    small.width = result.width;
    small.height = result.height;
    small.getContext("2d").putImageData(new ImageData(rgba, result.width, result.height), 0, 0);

    this.canvas.width = result.width * scale;
    this.canvas.height = result.height * scale;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, this.canvas.width, this.canvas.height);

    const sizeName = size === "medium" ? "Medium" : "Small";
    return `${sizeName} · ${MODE_LABELS[style]} · ${result.modules} × ${result.modules} modules`;
  }

  download() {
    if (this.canvas.hidden || !this.canvas.width) return;
    const link = document.createElement("a");
    link.href = this.canvas.toDataURL("image/png");
    const suffix = this.lastStyle === "plain" ? "" : `-${this.lastStyle}-${this.size()}`;
    link.download = `picture-qr${suffix}.png`;
    link.click();
  }
}

/* Resizes the picture to exactly width x height with progressive downscaling for quality. */
function makeSampler(picture) {
  const sourceWidth = picture.naturalWidth || picture.width;
  const sourceHeight = picture.naturalHeight || picture.height;
  return (width, height) => {
    let source = picture;
    let sw = sourceWidth;
    let sh = sourceHeight;
    while (sw >= width * 2 && sh >= height * 2) {
      const step = document.createElement("canvas");
      step.width = Math.max(width, Math.floor(sw / 2));
      step.height = Math.max(height, Math.floor(sh / 2));
      const stepCtx = step.getContext("2d");
      stepCtx.imageSmoothingEnabled = true;
      stepCtx.imageSmoothingQuality = "high";
      stepCtx.drawImage(source, 0, 0, step.width, step.height);
      source = step;
      sw = step.width;
      sh = step.height;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  };
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    image.src = url;
  });
}

function releasePicture(picture) {
  if (picture instanceof HTMLImageElement && picture.src.startsWith("blob:")) {
    URL.revokeObjectURL(picture.src);
  }
}

function sourceUrl(picture) {
  if (picture instanceof HTMLCanvasElement) return picture.toDataURL("image/jpeg", 0.85);
  return picture.src;
}

function createSamplePicture() {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 960;
  const ctx = canvas.getContext("2d");
  const sky = ctx.createLinearGradient(0, 0, 0, 960);
  sky.addColorStop(0, "#f7f3ea");
  sky.addColorStop(0.55, "#f2c9a6");
  sky.addColorStop(1, "#d96c4a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 960, 960);

  ctx.fillStyle = "#fff4d6";
  ctx.beginPath();
  ctx.arc(660, 300, 120, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#6b4a3a";
  ctx.beginPath();
  ctx.moveTo(0, 700);
  ctx.quadraticCurveTo(200, 560, 420, 660);
  ctx.quadraticCurveTo(620, 740, 960, 600);
  ctx.lineTo(960, 960);
  ctx.lineTo(0, 960);
  ctx.fill();

  ctx.fillStyle = "#2f2a26";
  ctx.beginPath();
  ctx.moveTo(0, 820);
  ctx.quadraticCurveTo(300, 720, 520, 800);
  ctx.quadraticCurveTo(760, 880, 960, 780);
  ctx.lineTo(960, 960);
  ctx.lineTo(0, 960);
  ctx.fill();

  ctx.strokeStyle = "#2f2a26";
  ctx.lineWidth = 26;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(250, 860);
  ctx.lineTo(250, 420);
  ctx.moveTo(250, 560);
  ctx.lineTo(150, 460);
  ctx.moveTo(250, 500);
  ctx.lineTo(360, 400);
  ctx.stroke();
  ctx.fillStyle = "#2f2a26";
  for (const [x, y, r] of [[250, 380, 90], [150, 430, 60], [360, 370, 70], [300, 300, 60]]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

const app = new PictureQR();
