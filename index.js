const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public')); 
app.use(express.urlencoded({ extended: true })); 

// Renderの環境変数から認証情報を読み込む
const creds = JSON.parse(process.env.GOOGLE_CREDS);

const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SPREADSHEET_ID = '12YjC4Gz5hP1utf3JlYo5-KqwB-hegaqFKtfIydggPm4'; 
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

app.get('/', (req, res) => res.render('login'));

app.post('/login', async (req, res) => {
    const { studentId, type } = req.body;
    try {
        await doc.loadInfo();
        const infoSheet = doc.sheetsByTitle['生徒情報'];
        const rows = await infoSheet.getRows();
        const user = rows.find(row => row.get('studentId').toString().trim() === studentId.trim());
        if (!user && type) await infoSheet.addRow({ studentId, type });
        res.redirect(`/mypage/${studentId}`);
    } catch (err) { res.status(500).send('Login Error'); }
});

app.get('/mypage/:id', async (req, res) => {
    try {
        const studentId = req.params.id;
        await doc.loadInfo();

        // 【日本時間で今日の日付を取得】
        const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });

        const attendRows = await doc.sheetsByTitle['登校ログ'].getRows();
        const earnedLogs = attendRows.filter(row => row.get('studentId').toString().trim() === studentId.trim());
        const earnedCount = earnedLogs.length;

        // 【新機能】重複チェック：今日すでに登校しているか
        const hasAttendedToday = earnedLogs.some(row => row.get('date') === today);

        // 【新機能】登校履歴（新しい順に並び替え）
        const attendanceHistory = earnedLogs.map(row => row.get('date')).reverse();

        const consumeRows = await doc.sheetsByTitle['ガチャ消費ログ'].getRows();
        const userConsumeRows = consumeRows.filter(row => row.get('studentId').toString().trim() === studentId.trim());
        
        const unexchangedPrizes = userConsumeRows.filter(row => {
            const status = (row.get('status') || "").toString().trim();
            return status !== '交換済み';
        });

        const gachaTickets = earnedCount - userConsumeRows.filter(row => row.get('action') === '通常').length;

        const infoRows = await doc.sheetsByTitle['生徒情報'].getRows();
        const user = infoRows.find(row => row.get('studentId').toString().trim() === studentId.trim());
        const userType = user ? user.get('type') : '低学年';

        let hasBonus = false;
        let bonusType = ""; 
        if (userType === "受験生") {
            if (earnedCount === 10) bonusType = "①";
            else if (earnedCount === 20) bonusType = "②";
        } else {
            if (earnedCount === 5) bonusType = "①";
            else if (earnedCount === 10) bonusType = "②";
        }

        if (bonusType !== "") {
            const alreadyPulled = userConsumeRows.some(row => {
                const pName = row.get('prize') || "";
                return row.get('action') === 'ボーナス' && pName.includes(`【${earnedCount}回達成】`);
            });
            if (!alreadyPulled) hasBonus = true;
        }

        res.render('mypage', { 
            id: studentId, gachaTickets, userType, earnedCount, unexchangedPrizes, 
            hasBonus, bonusType, hasAttendedToday, attendanceHistory 
        });
    } catch (err) { res.status(500).send('Mypage Error'); }
});

app.post('/attend', async (req, res) => {
    const { studentId } = req.body;
    try {
        await doc.loadInfo();
        const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
        
        const attendSheet = doc.sheetsByTitle['登校ログ'];
        const rows = await attendSheet.getRows();
        // サーバー側でも重複チェック
        const alreadyDone = rows.some(row => 
            row.get('studentId').toString().trim() === studentId.trim() && 
            row.get('date') === today
        );

        if (!alreadyDone) {
            await attendSheet.addRow({ date: today, studentId });
        }
        res.redirect(`/mypage/${studentId}`);
    } catch (err) { res.status(500).send('Attend Error'); }
});

app.get('/gacha/:id', async (req, res) => {
    try {
        const studentId = req.params.id;
        await doc.loadInfo();
        const prizes = await doc.sheetsByTitle['景品'].getRows();
        const resultText = prizes[Math.floor(Math.random() * prizes.length)].get('prizeName');
        await doc.sheetsByTitle['ガチャ消費ログ'].addRow({ date: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }), studentId, action: '通常', prize: resultText, status: '未交換' });
        res.render('gacha', { id: studentId, result: resultText });
    } catch (err) { res.status(500).send('Gacha Error'); }
});

app.get('/bonus-gacha/:id/:count/:type', async (req, res) => {
    try {
        const { id, count, type } = req.params;
        await doc.loadInfo();
        const sheetName = `ボーナス景品${type}`;
        const prizes = await doc.sheetsByTitle[sheetName].getRows();
        const resultText = prizes[Math.floor(Math.random() * prizes.length)].get('prizeName');
        await doc.sheetsByTitle['ガチャ消費ログ'].addRow({ date: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }), studentId: id, action: 'ボーナス', prize: `🎁【${count}回達成】${resultText}`, status: '未交換' });
        res.render('gacha', { id, result: resultText });
    } catch (err) { res.status(500).send('Bonus Error'); }
});

app.post('/consume-ticket', async (req, res) => {
    const { studentId, prizeName, date } = req.body;
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['ガチャ消費ログ'];
        const rows = await sheet.getRows();
        const row = rows.find(r => 
            r.get('studentId').toString().trim() === studentId.toString().trim() && 
            r.get('prize').toString().trim() === prizeName.toString().trim() && 
            r.get('date').toString().trim() === date.toString().trim()
        );
        if (row) {
            row.set('status', '交換済み');
            await row.save();
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false });
        }
    } catch (err) { res.status(500).json({ success: false }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));