class QRGenerator {
    constructor() {
        this.qrCode = null;
        this.attachEventListeners();
    }
    generateQR(text) {
        if (!text.trim()) return;
        const container = document.getElementById('qrContainer');
        container.innerHTML = '';
        this.qrCode = new QRCode(container, { text: text, width: 200, height: 200 });
        document.getElementById('downloadBtn').style.display = 'block';
    }
    downloadQR() {
        const canvas = document.querySelector('#qrContainer canvas');
        if (canvas) {
            const link = document.createElement('a');
            link.href = canvas.toDataURL();
            link.download = 'qrcode.png';
            link.click();
        }
    }
    attachEventListeners() {
        document.getElementById('generateBtn').addEventListener('click', () => {
            this.generateQR(document.getElementById('textInput').value);
        });
        document.getElementById('downloadBtn').addEventListener('click', () => this.downloadQR());
    }
}
const app = new QRGenerator();
