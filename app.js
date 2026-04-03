const App = (() => {
    // ===== FIREBASE =====

    const firebaseConfig = {
        apiKey: "AIzaSyD8NYyre38S7xTKVPhDGuwwRGDPoE9uFhg",
        authDomain: "journal-alimentaire-448a4.firebaseapp.com",
        projectId: "journal-alimentaire-448a4",
        storageBucket: "journal-alimentaire-448a4.firebasestorage.app",
        messagingSenderId: "552121003349",
        appId: "1:552121003349:web:61c19eaa82aad15bddd3dc"
    };

    firebase.initializeApp(firebaseConfig);
    const firestore = firebase.firestore();
    const auth = firebase.auth();
    auth.languageCode = 'fr';
    let currentUser = null;

    function entriesRef() {
        return firestore.collection('users').doc(currentUser.uid).collection('entries');
    }

    let currentScreen = 'home';
    let screenHistory = [];
    let editingEntryId = null;
    let calendarDate = new Date();
    let selectedCalDate = null;
    let recognition = null;
    let currentMicTarget = null;

    const MEAL_LABELS = {
        'petit-dejeuner': 'Petit-déj',
        'dejeuner': 'Déjeuner',
        'gouter': 'Goûter',
        'diner': 'Dîner',
        'grignotage': 'Grignotage',
        'autre': 'Autre'
    };

    const EMOTION_LABELS = {
        'neutre': 'Neutre',
        'joie': 'Joie',
        'tristesse': 'Tristesse',
        'peur': 'Peur / Angoisse',
        'colere': 'Colère',
        'degout': 'Dégoût',
        'culpabilite': 'Culpabilité',
        'honte': 'Honte',
        'stress': 'Stress',
        'ennui': 'Ennui',
        'frustration': 'Frustration',
        'satisfaction': 'Satisfaction'
    };

    // ===== DATABASE (Firestore) =====

    async function dbAdd(entry) {
        await entriesRef().doc(entry.id).set(entry);
    }

    async function dbGet(id) {
        const doc = await entriesRef().doc(id).get();
        return doc.exists ? doc.data() : undefined;
    }

    async function dbDelete(id) {
        await entriesRef().doc(id).delete();
    }

    async function dbGetByDate(dateStr) {
        const snap = await entriesRef().where('date', '==', dateStr).get();
        return snap.docs.map(d => d.data()).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    }

    async function dbGetAll() {
        const snap = await entriesRef().get();
        return snap.docs.map(d => d.data());
    }

    async function dbGetDateRange(from, to) {
        const snap = await entriesRef().where('date', '>=', from).where('date', '<=', to).get();
        return snap.docs.map(d => d.data()).sort((a, b) =>
            a.date === b.date ? (a.time || '').localeCompare(b.time || '') : a.date.localeCompare(b.date)
        );
    }

    async function dbGetDatesWithEntries(year, month) {
        const from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month + 1, 0).getDate();
        const to = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const snap = await entriesRef().where('date', '>=', from).where('date', '<=', to).get();
        return new Set(snap.docs.map(d => d.data().date));
    }

    // ===== AUTH =====

    function showLoginScreen() {
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
    }

    function hideLoginScreen() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
    }

    async function loginWithGoogle() {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
            await auth.signInWithPopup(provider);
        } catch (e) {
            if (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-closed-by-user') {
                try { await auth.signInWithRedirect(provider); } catch (e2) { showToast('Erreur de connexion'); }
            } else if (e.code !== 'auth/cancelled-popup-request') {
                showToast('Erreur de connexion');
                console.error(e);
            }
        }
    }

    function logout() {
        showConfirm('Se déconnecter ?', 'Vos données restent sauvegardées dans le cloud.', async () => {
            await auth.signOut();
        });
    }

    // ===== MIGRATION (IndexedDB → Firestore) =====

    function readOldIndexedDB() {
        return new Promise((resolve) => {
            const request = indexedDB.open('journal-auto-observation', 1);
            request.onerror = () => resolve([]);
            request.onupgradeneeded = (e) => { e.target.transaction.abort(); resolve([]); };
            request.onsuccess = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('entries')) { db.close(); resolve([]); return; }
                const tx = db.transaction('entries', 'readonly');
                const req = tx.objectStore('entries').getAll();
                req.onsuccess = () => { db.close(); resolve(req.result || []); };
                req.onerror = () => { db.close(); resolve([]); };
            };
        });
    }

    async function migrateIfNeeded() {
        const key = 'journal-migrated-' + currentUser.uid;
        if (localStorage.getItem(key)) return;

        const oldEntries = await readOldIndexedDB();
        if (oldEntries.length > 0) {
            showToast(`Migration de ${oldEntries.length} entrées...`, 5000);
            const BATCH_SIZE = 400;
            for (let i = 0; i < oldEntries.length; i += BATCH_SIZE) {
                const batch = firestore.batch();
                const chunk = oldEntries.slice(i, i + BATCH_SIZE);
                for (const entry of chunk) {
                    batch.set(entriesRef().doc(entry.id), entry);
                }
                await batch.commit();
            }
            showToast(`${oldEntries.length} entrées migrées avec succès !`);
        }
        localStorage.setItem(key, 'true');
    }

    // ===== NAVIGATION =====

    let trendsPeriod = 30;

    function navigate(screen) {
        if (screen === currentScreen) return;
        showScreen(screen);
        if (screen === 'home') loadTodayEntries();
        if (screen === 'history') renderCalendar();
        if (screen === 'trends') loadTrends();
        if (screen === 'export') loadStats();
    }

    function showScreen(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(`screen-${name}`).classList.add('active');

        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const navBtn = document.querySelector(`.nav-btn[data-screen="${name}"]`);
        if (navBtn) navBtn.classList.add('active');

        const nav = document.getElementById('bottom-nav');
        nav.style.display = (name === 'form' || name === 'detail') ? 'none' : 'flex';

        if (currentScreen !== name) screenHistory.push(currentScreen);
        currentScreen = name;
    }

    function goBack() {
        const prev = screenHistory.pop() || 'home';
        showScreen(prev);
        if (prev === 'home') loadTodayEntries();
        if (prev === 'history') renderCalendar();
        currentScreen = prev;
        screenHistory.pop();
    }

    // ===== AUTO-DETECT MEAL =====

    function autoDetectMeal() {
        const now = new Date();
        const minutes = now.getHours() * 60 + now.getMinutes();
        if (minutes < 600) return 'petit-dejeuner';       // avant 10h
        if (minutes < 720) return 'grignotage';            // 10h - 12h
        if (minutes < 870) return 'dejeuner';              // 12h - 14h30
        if (minutes < 960) return 'grignotage';            // 14h30 - 16h
        if (minutes < 1140) return 'gouter';               // 16h - 19h
        return 'diner';                                    // 19h+
    }

    // ===== HOME =====

    function getToday() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function formatDateFr(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }

    async function loadTodayEntries() {
        const today = getToday();
        document.getElementById('today-date').textContent = formatDateFr(today);

        const entries = await dbGetByDate(today);
        const container = document.getElementById('today-entries');
        document.getElementById('today-count').textContent = entries.length;

        if (entries.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                    </div>
                    <p>Aucune entrée aujourd'hui</p>
                    <p class="empty-hint">Appuyez sur + pour ajouter une observation</p>
                </div>`;
            return;
        }

        container.innerHTML = entries.map(e => renderEntryCard(e)).join('');
    }

    function renderEntryCard(entry) {
        const meal = MEAL_LABELS[entry.mealType] || '';
        const allEmotions = [...(entry.before?.emotions || []), ...(entry.after?.emotions || [])];
        const unique = [...new Map(allEmotions.map(e => [e.name, e])).values()];
        const tags = unique.slice(0, 3).map(e =>
            `<span class="emotion-tag">${EMOTION_LABELS[e.name] || e.name}</span>`).join('');

        return `
            <div class="entry-card" onclick="App.showDetail('${entry.id}')">
                <div class="entry-header">
                    <span class="entry-time">${entry.time || '--:--'}</span>
                    <div class="entry-actions-row">
                        ${meal ? `<span class="entry-meal">${meal}</span>` : ''}
                        <button class="btn-duplicate" onclick="event.stopPropagation(); App.duplicateEntry('${entry.id}')" title="Dupliquer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                    </div>
                </div>
                <div class="entry-preview">${escapeHtml(entry.behavior || 'Pas de description')}</div>
                ${tags ? `<div class="entry-emotions">${tags}</div>` : ''}
            </div>`;
    }

    // ===== QUICK ACTIONS =====

    function quickNormalEntry() {
        const detected = autoDetectMeal();

        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay';
        overlay.innerHTML = `
            <div class="dialog quick-meal-dialog">
                <h3>Repas normal</h3>
                <p>Quel repas souhaitez-vous enregistrer ?</p>
                <div class="chips compact-chips quick-meal-chips">
                    ${Object.entries(MEAL_LABELS).map(([key, label]) =>
                        `<button type="button" class="chip chip-sm${key === detected ? ' selected' : ''}" data-value="${key}">${label}</button>`
                    ).join('')}
                </div>
                <div class="dialog-actions">
                    <button class="btn-cancel" onclick="this.closest('.dialog-overlay').remove()">Annuler</button>
                    <button class="btn-confirm" id="quick-meal-confirm">Enregistrer</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.querySelectorAll('.quick-meal-chips .chip').forEach(chip => {
            chip.addEventListener('click', () => {
                overlay.querySelectorAll('.quick-meal-chips .chip').forEach(c => c.classList.remove('selected'));
                chip.classList.add('selected');
            });
        });

        document.getElementById('quick-meal-confirm').onclick = async () => {
            const selected = overlay.querySelector('.quick-meal-chips .chip.selected');
            const mealType = selected ? selected.dataset.value : detected;
            overlay.remove();

            const now = new Date();
            await dbAdd({
                id: generateId(),
                date: getToday(),
                time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
                mealType,
                behavior: 'Repas normal, rien à signaler',
                duration: '',
                before: { situation: '', emotions: [], thoughts: '' },
                after: { situation: '', emotions: [], thoughts: '' },
                consequences: { positive: '', negative: '' },
                situationChips: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            showToast(`${MEAL_LABELS[mealType]} enregistré`);
            loadTodayEntries();
        };

        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    async function duplicateLastEntry() {
        const today = getToday();
        let entries = await dbGetByDate(today);
        if (entries.length === 0) {
            const all = await dbGetAll();
            if (all.length === 0) {
                showToast('Aucune entrée à dupliquer');
                return;
            }
            entries = all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        }

        const last = entries[entries.length - 1] || entries[0];
        await duplicateEntry(last.id);
    }

    async function duplicateEntry(id) {
        const src = await dbGet(id);
        if (!src) return;

        const now = new Date();
        const newEntry = {
            ...JSON.parse(JSON.stringify(src)),
            id: generateId(),
            date: getToday(),
            time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
            mealType: autoDetectMeal(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        editingEntryId = newEntry.id;
        loadEntryIntoForm(null, newEntry);
        document.getElementById('form-title').textContent = 'Nouvelle entrée (copie)';
        document.getElementById('btn-delete-entry').classList.add('hidden');
        showScreen('form');
    }

    // ===== FORM =====

    function showForm(entryId) {
        editingEntryId = entryId || null;
        const formTitle = document.getElementById('form-title');
        const deleteBtn = document.getElementById('btn-delete-entry');

        if (entryId) {
            formTitle.textContent = 'Modifier l\'entrée';
            deleteBtn.classList.remove('hidden');
            loadEntryIntoForm(entryId);
        } else {
            formTitle.textContent = 'Nouvelle entrée';
            deleteBtn.classList.add('hidden');
            resetForm();
        }

        showScreen('form');
    }

    function resetForm() {
        const now = new Date();
        document.getElementById('entry-date').value = getToday();
        document.getElementById('entry-time').value =
            String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

        const detectedMeal = autoDetectMeal();
        document.querySelectorAll('#meal-chips .chip').forEach(c => {
            c.classList.toggle('selected', c.dataset.value === detectedMeal);
        });

        const cravingSection = document.getElementById('craving-section');
        if (cravingSection) cravingSection.classList.toggle('hidden', detectedMeal !== 'grignotage');

        document.getElementById('entry-behavior').value = '';
        document.getElementById('entry-duration').value = '';

        document.querySelectorAll('#quick-emotions .chip').forEach(c => c.classList.remove('selected'));
        document.getElementById('before-intensity').innerHTML = '';
        updateEmotionHint();
        document.getElementById('quick-notes').value = '';

        document.querySelectorAll('#before-situation-chips .chip').forEach(c => c.classList.remove('selected'));
        document.getElementById('before-situation').value = '';
        document.getElementById('before-thoughts').value = '';

        document.querySelectorAll('#after-emotions .chip').forEach(c => c.classList.remove('selected'));
        document.getElementById('after-intensity').innerHTML = '';
        document.getElementById('after-thoughts').value = '';

        setCraving(null);

        document.querySelectorAll('.section-body').forEach(b => b.classList.add('collapsed'));
        document.querySelectorAll('.toggle-chevron').forEach(c => c.style.transform = '');
    }

    function setCraving(val) {
        const chips = document.querySelectorAll('#craving-toggle .chip');
        const details = document.getElementById('craving-details');
        chips.forEach(c => c.classList.remove('selected'));

        if (val === true) {
            chips[0].classList.add('selected');
            details.classList.remove('hidden');
        } else if (val === false) {
            chips[1].classList.add('selected');
            details.classList.add('hidden');
            setCravingSatisfied(null);
        } else {
            details.classList.add('hidden');
            setCravingSatisfied(null);
        }
    }

    function setCravingSatisfied(val) {
        const chips = document.querySelectorAll('#craving-satisfied-toggle .chip');
        const priceRow = document.getElementById('craving-price-row');
        chips.forEach(c => c.classList.remove('selected'));

        if (val === true) {
            chips[0].classList.add('selected');
            priceRow.classList.remove('hidden');
        } else if (val === false) {
            chips[1].classList.add('selected');
            priceRow.classList.add('hidden');
            document.getElementById('pastry-price').value = '';
            document.getElementById('pastry-desc').value = '';
        } else {
            priceRow.classList.add('hidden');
            document.getElementById('pastry-price').value = '';
            document.getElementById('pastry-desc').value = '';
        }
    }

    async function loadEntryIntoForm(id, prefill) {
        const entry = prefill || await dbGet(id);
        if (!entry) return;

        document.getElementById('entry-date').value = entry.date || '';
        document.getElementById('entry-time').value = entry.time || '';

        document.querySelectorAll('#meal-chips .chip').forEach(c => {
            c.classList.toggle('selected', c.dataset.value === entry.mealType);
        });

        const cravingSection = document.getElementById('craving-section');
        if (cravingSection) cravingSection.classList.toggle('hidden', entry.mealType !== 'grignotage');

        document.getElementById('entry-behavior').value = entry.behavior || '';
        document.getElementById('entry-duration').value = entry.duration || '';

        // Quick emotions = before emotions
        const beforeEmotions = entry.before?.emotions || [];
        document.querySelectorAll('#quick-emotions .chip').forEach(c => c.classList.remove('selected'));
        const sliderContainer = document.getElementById('before-intensity');
        sliderContainer.innerHTML = '';

        beforeEmotions.forEach(em => {
            const chip = document.querySelector(`#quick-emotions [data-emotion="${em.name}"]`);
            if (chip) chip.classList.add('selected');
            addIntensitySlider('before-intensity', em.name, em.intensity);
        });
        updateEmotionHint();

        // Quick notes = before thoughts (prefer quick-notes, fallback to before.thoughts)
        document.getElementById('quick-notes').value = entry.before?.thoughts || '';

        // Situation chips
        const sitChips = entry.situationChips || [];
        document.querySelectorAll('#before-situation-chips .chip').forEach(c => {
            c.classList.toggle('selected', sitChips.includes(c.dataset.sit));
        });
        document.getElementById('before-situation').value = entry.before?.situation || '';
        document.getElementById('before-thoughts').value = '';

        // After
        const afterEmotions = entry.after?.emotions || [];
        document.querySelectorAll('#after-emotions .chip').forEach(c => c.classList.remove('selected'));
        document.getElementById('after-intensity').innerHTML = '';
        afterEmotions.forEach(em => {
            const chip = document.querySelector(`#after-emotions [data-emotion="${em.name}"]`);
            if (chip) chip.classList.add('selected');
            addIntensitySlider('after-intensity', em.name, em.intensity);
        });
        document.getElementById('after-thoughts').value = entry.after?.thoughts || (entry.after?.situation ? entry.after.situation + '\n' + (entry.after?.thoughts || '') : '').trim();

        // Craving fields
        if (entry.craving === true) {
            setCraving(true);
            if (entry.cravingSatisfied === true) {
                setCravingSatisfied(true);
                document.getElementById('pastry-desc').value = entry.pastryDesc || '';
                document.getElementById('pastry-price').value = entry.pastryPrice || '';
            } else if (entry.cravingSatisfied === false) {
                setCravingSatisfied(false);
            }
        } else if (entry.craving === false) {
            setCraving(false);
        } else {
            setCraving(null);
        }

        // Expand sections that have content
        const hasBefore = entry.before?.situation || sitChips.length > 0;
        const hasAfter = entry.after?.situation || afterEmotions.length > 0 || entry.after?.thoughts;
        const hasConseq = entry.consequences?.positive || entry.consequences?.negative;

        document.querySelectorAll('.section-body').forEach(b => b.classList.add('collapsed'));
        document.querySelectorAll('.toggle-chevron').forEach(c => c.style.transform = '');

        if (hasBefore) expandSection(0);
        if (hasAfter) expandSection(1);
        if (hasConseq) expandSection(2);
    }

    function expandSection(index) {
        const sections = document.querySelectorAll('.collapsible');
        if (sections[index]) {
            const body = sections[index].querySelector('.section-body');
            const chevron = sections[index].querySelector('.toggle-chevron');
            if (body) body.classList.remove('collapsed');
            if (chevron) chevron.style.transform = 'rotate(90deg)';
        }
    }

    function getSelectedEmotions(prefix) {
        const container = document.getElementById(`${prefix}-intensity`);
        const items = container.querySelectorAll('.intensity-item');
        return Array.from(items).map(item => ({
            name: item.dataset.emotion,
            intensity: parseInt(item.querySelector('.intensity-slider').value)
        }));
    }

    function getQuickEmotions() {
        const selected = document.querySelectorAll('#quick-emotions .chip.selected');
        const intensityContainer = document.getElementById('before-intensity');
        return Array.from(selected).map(chip => {
            const name = chip.dataset.emotion;
            const slider = intensityContainer.querySelector(`[data-emotion="${name}"] .intensity-slider`);
            return {
                name,
                intensity: slider ? parseInt(slider.value) : 5
            };
        });
    }

    function getSelectedSituationChips() {
        return Array.from(document.querySelectorAll('#before-situation-chips .chip.selected'))
            .map(c => c.dataset.sit);
    }

    function collectFormData() {
        const selectedMeal = document.querySelector('#meal-chips .chip.selected');
        const quickNotes = document.getElementById('quick-notes').value.trim();
        const beforeThoughts = document.getElementById('before-thoughts').value.trim();

        return {
            id: editingEntryId || generateId(),
            date: document.getElementById('entry-date').value,
            time: document.getElementById('entry-time').value,
            mealType: selectedMeal ? selectedMeal.dataset.value : '',
            behavior: document.getElementById('entry-behavior').value.trim(),
            duration: document.getElementById('entry-duration').value.trim(),
            before: {
                situation: document.getElementById('before-situation').value.trim(),
                emotions: getQuickEmotions(),
                thoughts: quickNotes || beforeThoughts
            },
            after: {
                situation: '',
                emotions: getSelectedEmotions('after'),
                thoughts: document.getElementById('after-thoughts').value.trim()
            },
            situationChips: getSelectedSituationChips(),
            craving: getCravingValue(),
            cravingSatisfied: getCravingSatisfiedValue(),
            pastryDesc: getCravingSatisfiedValue() ? document.getElementById('pastry-desc').value.trim() : '',
            pastryPrice: getCravingSatisfiedValue() ? parseFloat(document.getElementById('pastry-price').value) || 0 : 0,
            createdAt: editingEntryId ? undefined : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    function getCravingValue() {
        const sel = document.querySelector('#craving-toggle .chip.selected');
        if (!sel) return null;
        return sel.dataset.val === 'yes';
    }

    function getCravingSatisfiedValue() {
        const sel = document.querySelector('#craving-satisfied-toggle .chip.selected');
        if (!sel) return null;
        return sel.dataset.val === 'yes';
    }

    async function saveEntry() {
        const data = collectFormData();
        if (!data.date) { showToast('Veuillez saisir une date'); return; }

        if (editingEntryId) {
            const existing = await dbGet(editingEntryId);
            if (existing) data.createdAt = existing.createdAt;
        }

        await dbAdd(data);
        showToast(editingEntryId ? 'Entrée modifiée' : 'Entrée enregistrée');
        editingEntryId = null;
        goBack();
    }

    async function deleteEntry() {
        if (!editingEntryId) return;
        showConfirm('Supprimer cette entrée ?', 'Cette action est irréversible.', async () => {
            await dbDelete(editingEntryId);
            editingEntryId = null;
            showToast('Entrée supprimée');
            goBack();
        });
    }

    // ===== DETAIL =====

    async function showDetail(id) {
        const entry = await dbGet(id);
        if (!entry) return;

        document.getElementById('detail-content').innerHTML = renderDetail(entry);
        document.getElementById('detail-content').dataset.entryId = id;
        showScreen('detail');
    }

    function renderDetail(entry) {
        const meal = MEAL_LABELS[entry.mealType] || '';
        const date = formatDateFr(entry.date);
        const sitChips = (entry.situationChips || []).map(s => {
            const labels = { maison: 'A la maison', bureau: 'Au bureau', exterieur: 'A l\'extérieur', restaurant: 'Au restaurant', seul: 'Seul(e)', famille: 'En famille', amis: 'Entre amis', collegues: 'Avec collègues', boyfriend: 'Avec boyfriend' };
            return labels[s] || s;
        });

        function renderEmotions(emotions) {
            if (!emotions?.length) return '<span class="detail-value empty">Non renseigné</span>';
            return `<div class="detail-emotions-list">${emotions.map(e =>
                `<span class="detail-emotion">${EMOTION_LABELS[e.name] || e.name} <span class="intensity">${e.intensity}/10</span></span>`
            ).join('')}</div>`;
        }

        function field(label, value) {
            return `<div class="detail-field"><div class="detail-label">${label}</div><div class="detail-value ${!value ? 'empty' : ''}">${escapeHtml(value) || 'Non renseigné'}</div></div>`;
        }

        let html = `
            <div class="detail-section">
                <h3>Le moment</h3>
                ${field('Date', date)}
                ${field('Heure', entry.time || '')}
                ${meal ? field('Type de repas', meal) : ''}
                ${field('Comportement', entry.behavior)}
                ${field('Durée', entry.duration)}
            </div>
            <div class="detail-section">
                <h3>Avant le repas</h3>
                ${sitChips.length ? field('Contexte', sitChips.join(', ')) : ''}
                ${field('Situation', entry.before?.situation)}
                <div class="detail-field"><div class="detail-label">Émotions</div>${renderEmotions(entry.before?.emotions)}</div>
                ${field('Pensées', entry.before?.thoughts)}
            </div>
            <div class="detail-section">
                <h3>Après le repas</h3>
                ${field('Situation', entry.after?.situation)}
                <div class="detail-field"><div class="detail-label">Émotions</div>${renderEmotions(entry.after?.emotions)}</div>
                ${field('Pensées', entry.after?.thoughts)}
            </div>`;

        if (entry.craving === true) {
            let cravingText = 'Oui';
            if (entry.cravingSatisfied === true) {
                cravingText += ' — Assouvie';
                if (entry.pastryDesc) cravingText += ` (${escapeHtml(entry.pastryDesc)})`;
                if (entry.pastryPrice > 0) cravingText += ` — ${entry.pastryPrice.toFixed(2)} €`;
            } else if (entry.cravingSatisfied === false) {
                cravingText += ' — Résistée';
            }
            html += `<div class="detail-section"><h3>Pulsion sucrée</h3>${field('', cravingText)}</div>`;
        }

        if (entry.consequences?.positive || entry.consequences?.negative) {
            html += `<div class="detail-section"><h3>Conséquences</h3>
                ${field('Positives', entry.consequences?.positive)}
                ${field('Négatives', entry.consequences?.negative)}</div>`;
        }

        return html;
    }

    function editFromDetail() {
        const id = document.getElementById('detail-content').dataset.entryId;
        if (id) showForm(id);
    }

    // ===== CALENDAR / HISTORY =====

    async function renderCalendar() {
        const year = calendarDate.getFullYear();
        const month = calendarDate.getMonth();
        const monthNames = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
        document.getElementById('month-label').textContent = `${monthNames[month]} ${year}`;

        const datesWithEntries = await dbGetDatesWithEntries(year, month);
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const startDay = firstDay === 0 ? 6 : firstDay - 1;
        const today = getToday();

        let html = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(d => `<div class="cal-header">${d}</div>`).join('');
        for (let i = 0; i < startDay; i++) html += '<div class="cal-day empty"></div>';

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            let cls = 'cal-day';
            if (dateStr === today) cls += ' today';
            if (datesWithEntries.has(dateStr)) cls += ' has-entries';
            if (dateStr === selectedCalDate) cls += ' selected';
            html += `<div class="${cls}" onclick="App.selectDate('${dateStr}')">${day}</div>`;
        }

        document.getElementById('calendar-grid').innerHTML = html;
    }

    function prevMonth() { calendarDate.setMonth(calendarDate.getMonth() - 1); renderCalendar(); }
    function nextMonth() { calendarDate.setMonth(calendarDate.getMonth() + 1); renderCalendar(); }

    async function selectDate(dateStr) {
        selectedCalDate = dateStr;
        renderCalendar();
        document.getElementById('selected-date-label').textContent = formatDateFr(dateStr);

        const entries = await dbGetByDate(dateStr);
        const container = document.getElementById('history-entries');
        container.innerHTML = entries.length === 0
            ? '<div class="empty-state"><p>Aucune entrée ce jour</p></div>'
            : entries.map(e => renderEntryCard(e)).join('');
    }

    // ===== SPEECH TO TEXT =====

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    function initSpeech() {}

    function startSpeech(targetId) {
        const target = document.getElementById(targetId);

        if (isIOS) {
            if (target) {
                target.focus();
                showToast('Tapez le micro 🎤 en bas de votre clavier pour dicter', 4000);
            }
            return;
        }

        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            if (target) target.focus();
            showToast('Dictée non disponible — tapez le micro 🎤 du clavier');
            return;
        }

        if (currentMicTarget) { stopSpeech(); return; }
        currentMicTarget = targetId;

        recognition = new SR();
        recognition.lang = 'fr-FR';
        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onresult = (event) => {
            if (!currentMicTarget) return;
            const t = document.getElementById(currentMicTarget);
            if (!t) return;

            let transcript = '';
            for (let i = 0; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            if (transcript) {
                t.value = t.value ? t.value + ' ' + transcript : transcript;
            }
        };

        recognition.onerror = (event) => {
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                showToast('Accès au micro refusé');
                stopSpeech();
            } else if (event.error === 'no-speech') {
                if (currentMicTarget) {
                    try { recognition.start(); } catch (e) { stopSpeech(); }
                }
            } else if (event.error !== 'aborted') {
                stopSpeech();
            }
        };

        recognition.onend = () => {
            if (currentMicTarget) {
                try { recognition.start(); } catch (e) { stopSpeech(); }
            }
        };

        try { recognition.start(); } catch (e) { stopSpeech(); }
    }

    function stopSpeech() {
        currentMicTarget = null;
        if (recognition && typeof recognition.stop === 'function') {
            try { recognition.stop(); } catch (e) { /* ignore */ }
        }
        recognition = null;
    }

    // ===== EXPORT =====

    async function loadStats() {
        const all = await dbGetAll();
        document.getElementById('stat-total').textContent = all.length;
        document.getElementById('stat-days').textContent = new Set(all.map(e => e.date)).size;

        if (all.length > 0) {
            const sorted = all.sort((a, b) => a.date.localeCompare(b.date));
            document.getElementById('stat-first').textContent = new Date(sorted[0].date + 'T00:00:00')
                .toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
            document.getElementById('export-from').value = sorted[0].date;
            document.getElementById('export-to').value = sorted[sorted.length - 1].date;
        }
    }

    async function getExportEntries() {
        const from = document.getElementById('export-from').value;
        const to = document.getElementById('export-to').value;
        if (!from || !to) return (await dbGetAll()).sort((a, b) => a.date.localeCompare(b.date));
        return await dbGetDateRange(from, to);
    }

    async function exportJSON() {
        const entries = await dbGetAll();
        const blob = new Blob([JSON.stringify({ appName: 'Journal d\'auto-observation', exportDate: new Date().toISOString(), version: 1, entries }, null, 2)], { type: 'application/json' });
        downloadBlob(blob, `journal-sauvegarde-${getToday()}.json`);
        showToast(`${entries.length} entrées sauvegardées`);
    }

    async function exportCSV() {
        const entries = await getExportEntries();
        if (!entries.length) { showToast('Aucune entrée à exporter'); return; }

        const headers = ['Date', 'Heure', 'Type de repas', 'Comportement', 'Durée', 'Avant - Situation', 'Avant - Émotions', 'Avant - Pensées', 'Après - Situation', 'Après - Émotions', 'Après - Pensées', 'Pulsion sucrée', 'Assouvie', 'Prix pâtisserie', 'Conséquences +', 'Conséquences -'];
        const rows = entries.map(e => [
            e.date, e.time || '', MEAL_LABELS[e.mealType] || '', e.behavior || '', e.duration || '',
            e.before?.situation || '',
            (e.before?.emotions || []).map(em => `${EMOTION_LABELS[em.name] || em.name} (${em.intensity}/10)`).join(', '),
            e.before?.thoughts || '',
            e.after?.situation || '',
            (e.after?.emotions || []).map(em => `${EMOTION_LABELS[em.name] || em.name} (${em.intensity}/10)`).join(', '),
            e.after?.thoughts || '',
            e.craving ? 'Oui' : (e.craving === false ? 'Non' : ''),
            e.cravingSatisfied ? 'Oui' : (e.cravingSatisfied === false ? 'Non' : ''),
            e.pastryPrice > 0 ? e.pastryPrice.toFixed(2) : '',
            e.consequences?.positive || '', e.consequences?.negative || ''
        ]);

        const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
        downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), `journal-export-${getToday()}.csv`);
        showToast(`${entries.length} entrées exportées`);
    }

    async function exportPrint() {
        const entries = await getExportEntries();
        if (!entries.length) { showToast('Aucune entrée à exporter'); return; }

        const from = document.getElementById('export-from').value;
        const to = document.getElementById('export-to').value;

        let html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Journal d'auto-observation</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;color:#2D3436;padding:20px;font-size:13px;line-height:1.5}
.header{text-align:center;margin-bottom:30px;padding-bottom:16px;border-bottom:2px solid #6B8F71}
.header h1{font-size:22px;color:#6B8F71}.header p{font-size:13px;color:#636E72;margin-top:4px}
.entry{margin-bottom:24px;padding:16px;border:1px solid #E8E4E0;border-radius:8px;page-break-inside:avoid;border-left:4px solid #6B8F71}
.entry h3{font-size:14px;color:#6B8F71;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #eee}
.sub{font-weight:600;color:#5A7A5F;font-size:12px;margin-top:10px;margin-bottom:4px;text-transform:uppercase}
.field{margin-bottom:6px}.label{font-weight:600;color:#888;font-size:11px;text-transform:uppercase}.value{font-size:13px}
.emotions{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.emotion{background:#F5E6D3;padding:2px 8px;border-radius:10px;font-size:12px}
@media print{body{padding:0}.entry{border:1px solid #ccc}}</style></head><body>
<div class="header"><h1>Journal d'auto-observation</h1>
<p>Période : ${from ? formatDateFr(from) : 'début'} — ${to ? formatDateFr(to) : 'fin'}</p>
<p>${entries.length} entrée(s)</p></div>`;

        for (const e of entries) {
            const meal = MEAL_LABELS[e.mealType] || '';
            const bEm = (e.before?.emotions || []).map(em => `<span class="emotion">${EMOTION_LABELS[em.name] || em.name} ${em.intensity}/10</span>`).join('');
            const aEm = (e.after?.emotions || []).map(em => `<span class="emotion">${EMOTION_LABELS[em.name] || em.name} ${em.intensity}/10</span>`).join('');

            html += `<div class="entry"><h3>${formatDateFr(e.date)} à ${e.time || '--:--'} ${meal ? '— ' + meal : ''}</h3>
<div class="field"><span class="label">Comportement : </span><span class="value">${escapeHtml(e.behavior || '-')}</span></div>
<div class="field"><span class="label">Durée : </span><span class="value">${escapeHtml(e.duration || '-')}</span></div>
<div class="sub">Avant</div>
<div class="field"><span class="label">Situation : </span><span class="value">${escapeHtml(e.before?.situation || '-')}</span></div>
${bEm ? `<div class="field"><span class="label">Émotions : </span><div class="emotions">${bEm}</div></div>` : ''}
<div class="field"><span class="label">Pensées : </span><span class="value">${escapeHtml(e.before?.thoughts || '-')}</span></div>
<div class="sub">Après</div>
<div class="field"><span class="label">Situation : </span><span class="value">${escapeHtml(e.after?.situation || '-')}</span></div>
${aEm ? `<div class="field"><span class="label">Émotions : </span><div class="emotions">${aEm}</div></div>` : ''}
<div class="field"><span class="label">Pensées : </span><span class="value">${escapeHtml(e.after?.thoughts || '-')}</span></div>
${(e.consequences?.positive || e.consequences?.negative) ? `<div class="sub">Conséquences</div>
${e.consequences?.positive ? `<div class="field"><span class="label">+ </span><span class="value">${escapeHtml(e.consequences.positive)}</span></div>` : ''}
${e.consequences?.negative ? `<div class="field"><span class="label">- </span><span class="value">${escapeHtml(e.consequences.negative)}</span></div>` : ''}` : ''}
</div>`;
        }

        html += '</body></html>';
        const w = window.open('', '_blank');
        w.document.write(html);
        w.document.close();
        w.onload = () => w.print();
    }

    function importJSON() { document.getElementById('import-file').click(); }

    async function handleImport(event) {
        const file = event.target.files[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!Array.isArray(data.entries)) { showToast('Fichier invalide'); return; }
            showConfirm('Restaurer la sauvegarde ?', `${data.entries.length} entrées seront ajoutées.`, async () => {
                for (const entry of data.entries) await dbAdd(entry);
                showToast(`${data.entries.length} entrées restaurées`);
                loadTodayEntries();
                loadStats();
            });
        } catch (e) { showToast('Erreur de lecture du fichier'); }
        event.target.value = '';
    }

    // ===== UTILITIES =====

    function generateId() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 9); }

    function escapeHtml(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function downloadBlob(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    function showToast(message, duration) {
        const t = document.getElementById('toast');
        t.textContent = message;
        t.classList.remove('hidden');
        t.classList.add('show');
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 300); }, duration || 2500);
    }

    function showConfirm(title, message, onConfirm) {
        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay';
        overlay.innerHTML = `<div class="dialog"><h3>${title}</h3><p>${message}</p>
            <div class="dialog-actions"><button class="btn-cancel" onclick="this.closest('.dialog-overlay').remove()">Annuler</button>
            <button class="btn-confirm" id="dialog-confirm">Confirmer</button></div></div>`;
        document.body.appendChild(overlay);
        document.getElementById('dialog-confirm').onclick = () => { overlay.remove(); onConfirm(); };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    function toggleSection(titleEl) {
        const body = titleEl.parentElement.querySelector('.section-body');
        if (!body) return;
        const isCollapsed = body.classList.toggle('collapsed');
        const chevron = titleEl.querySelector('.toggle-chevron');
        if (chevron) chevron.style.transform = isCollapsed ? '' : 'rotate(90deg)';
    }

    function updateEmotionHint() {
        const hint = document.getElementById('no-emotions-hint');
        const sliders = document.getElementById('before-intensity');
        if (hint) hint.style.display = sliders.children.length > 0 ? 'none' : 'block';
    }

    function addIntensitySlider(containerId, emotionName, value) {
        const container = document.getElementById(containerId);
        const label = EMOTION_LABELS[emotionName] || emotionName;
        const val = value !== undefined ? value : 5;
        container.insertAdjacentHTML('beforeend', `
            <div class="intensity-item" data-emotion="${emotionName}">
                <span class="intensity-label">${label}</span>
                <input type="range" class="intensity-slider" min="0" max="10" value="${val}"
                       oninput="this.nextElementSibling.textContent = this.value">
                <span class="intensity-value">${val}</span>
            </div>`);
    }

    // ===== CHIP EVENT HANDLERS =====

    function initChips() {
        // Meal chips: single select + toggle craving section
        document.querySelectorAll('#meal-chips .chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll('#meal-chips .chip').forEach(c => c.classList.remove('selected'));
                chip.classList.add('selected');
                const cravingSection = document.getElementById('craving-section');
                if (cravingSection) {
                    cravingSection.classList.toggle('hidden', chip.dataset.value !== 'grignotage');
                }
            });
        });

        // Quick emotions (before): toggle with intensity sync
        document.querySelectorAll('#quick-emotions .chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const emotion = chip.dataset.emotion;
                const isSelected = chip.classList.toggle('selected');
                const sliderContainer = document.getElementById('before-intensity');

                if (isSelected) {
                    addIntensitySlider('before-intensity', emotion, 5);
                } else {
                    const slider = sliderContainer.querySelector(`[data-emotion="${emotion}"]`);
                    if (slider) slider.remove();
                }
                updateEmotionHint();
            });
        });

        // After emotions: toggle with intensity
        initEmotionChips('after');

        // Situation chips: multi-select
        document.querySelectorAll('#before-situation-chips .chip').forEach(chip => {
            chip.addEventListener('click', () => chip.classList.toggle('selected'));
        });
    }

    function initEmotionChips(prefix) {
        const container = document.getElementById(`${prefix}-emotions`);
        const sliderContainer = document.getElementById(`${prefix}-intensity`);

        container.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const emotion = chip.dataset.emotion;
                const isSelected = chip.classList.toggle('selected');
                if (isSelected) {
                    addIntensitySlider(`${prefix}-intensity`, emotion, 5);
                } else {
                    const slider = sliderContainer.querySelector(`[data-emotion="${emotion}"]`);
                    if (slider) slider.remove();
                }
            });
        });
    }

    // ===== TRENDS / ANALYTICS =====

    const STOP_WORDS = new Set(['le','la','les','de','du','des','un','une','et','en','au','aux','je','me','mon','ma','mes','ne','pas','que','qui','ce','se','son','sa','ses','il','elle','nous','vous','ils','elles','on','est','suis','ai','a','ont','sont','avec','pour','dans','sur','par','plus','très','trop','bien','mal','fait','faire','été','avoir','être','comme','mais','ou','car','donc','ni','si','ça','cela','tout','tous','aussi','même','cette','ces','lui','leur','y','rien','peu','beaucoup','encore','après','avant','quand','aussi','où','comment','pourquoi','sans','vers','chez','entre','sous','autre','autres','chaque','quelque','toujours','jamais','peut','vais','vas','va','allons','allez','vont','dit','dis','dit','était','avais','avait','puis','là','ici','vraiment']);

    function setPeriod(p) {
        trendsPeriod = p;
        document.querySelectorAll('.period-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.period === String(p));
        });
        loadTrends();
    }

    async function loadTrends() {
        const all = await dbGetAll();
        let entries;

        if (trendsPeriod === 'all') {
            entries = all;
        } else {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - trendsPeriod);
            const cutoffStr = cutoff.toISOString().slice(0, 10);
            entries = all.filter(e => e.date >= cutoffStr);
        }

        entries.sort((a, b) => a.date.localeCompare(b.date));

        renderSummary(entries);
        renderEmotionChart(entries, 'before', 'chart-emotions-before');
        renderEmotionChart(entries, 'after', 'chart-emotions-after');
        renderTransitions(entries);
        renderSituations(entries);
        renderMeals(entries);
        renderWeekdays(entries);
        renderSnackingFrequency(entries);
        renderSnackingContexts(entries);
        renderGuiltEvolution(entries);
        renderCravings(entries);
        renderBudget(entries);
        renderWords(entries);
        renderInsights(entries);
    }

    function renderSummary(entries) {
        const days = new Set(entries.map(e => e.date));
        document.getElementById('trend-total').textContent = entries.length;
        document.getElementById('trend-days').textContent = days.size;
        document.getElementById('trend-avg').textContent = days.size > 0
            ? (entries.length / days.size).toFixed(1) : '0';
    }

    function countEmotions(entries, phase) {
        const counts = {};
        entries.forEach(e => {
            const emotions = e[phase]?.emotions || [];
            emotions.forEach(em => {
                counts[em.name] = (counts[em.name] || 0) + 1;
            });
        });
        return Object.entries(counts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count);
    }

    function renderEmotionChart(entries, phase, containerId) {
        const container = document.getElementById(containerId);
        const data = countEmotions(entries, phase);

        if (data.length === 0) {
            container.innerHTML = '<p class="trend-empty">Pas encore de données</p>';
            return;
        }

        const max = data[0].count;
        container.innerHTML = data.slice(0, 6).map(d => {
            const pct = Math.round((d.count / max) * 100);
            const color = phase === 'before' ? 'var(--secondary)' : 'var(--primary)';
            return `<div class="bar-row">
                <span class="bar-label">${EMOTION_LABELS[d.name] || d.name}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
                <span class="bar-count">${d.count}</span>
            </div>`;
        }).join('');
    }

    function renderTransitions(entries) {
        const container = document.getElementById('chart-transitions');
        const transitions = {};

        entries.forEach(e => {
            const before = e.before?.emotions || [];
            const after = e.after?.emotions || [];
            if (before.length === 0 || after.length === 0) return;

            before.forEach(b => {
                after.forEach(a => {
                    if (b.name === a.name) return;
                    const key = `${b.name}→${a.name}`;
                    transitions[key] = (transitions[key] || 0) + 1;
                });
            });
        });

        const sorted = Object.entries(transitions)
            .map(([key, count]) => ({ key, count, parts: key.split('→') }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        if (sorted.length === 0) {
            container.innerHTML = '<p class="trend-empty">Remplissez les émotions avant et après pour voir les transitions</p>';
            return;
        }

        container.innerHTML = sorted.map(t => `
            <div class="transition-row">
                <span class="transition-from">${EMOTION_LABELS[t.parts[0]] || t.parts[0]}</span>
                <svg class="transition-arrow" width="24" height="16" viewBox="0 0 24 16"><path d="M0 8h20M16 3l5 5-5 5" fill="none" stroke="var(--text-lighter)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span class="transition-to">${EMOTION_LABELS[t.parts[1]] || t.parts[1]}</span>
                <span class="transition-count">${t.count}x</span>
            </div>`).join('');
    }

    function renderSituations(entries) {
        const container = document.getElementById('chart-situations');
        const counts = {};
        const sitLabels = { maison: 'A la maison', bureau: 'Au bureau', exterieur: 'A l\'extérieur', restaurant: 'Au restaurant', seul: 'Seul(e)', famille: 'En famille', amis: 'Entre amis', collegues: 'Avec collègues', boyfriend: 'Avec boyfriend' };

        entries.forEach(e => {
            (e.situationChips || []).forEach(s => {
                counts[s] = (counts[s] || 0) + 1;
            });
        });

        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

        if (sorted.length === 0) {
            container.innerHTML = '<p class="trend-empty">Utilisez les chips de situation pour voir les patterns</p>';
            return;
        }

        const max = sorted[0][1];
        container.innerHTML = sorted.map(([name, count]) => {
            const pct = Math.round((count / max) * 100);
            return `<div class="bar-row">
                <span class="bar-label">${sitLabels[name] || name}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--primary)"></div></div>
                <span class="bar-count">${count}</span>
            </div>`;
        }).join('');
    }

    function renderMeals(entries) {
        const container = document.getElementById('chart-meals');
        const counts = {};
        entries.forEach(e => {
            if (e.mealType) counts[e.mealType] = (counts[e.mealType] || 0) + 1;
        });

        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) { container.innerHTML = '<p class="trend-empty">Pas encore de données</p>'; return; }

        const max = sorted[0][1];
        container.innerHTML = sorted.map(([name, count]) => {
            const pct = Math.round((count / max) * 100);
            return `<div class="bar-row">
                <span class="bar-label">${MEAL_LABELS[name] || name}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--primary)"></div></div>
                <span class="bar-count">${count}</span>
            </div>`;
        }).join('');
    }

    function renderWeekdays(entries) {
        const container = document.getElementById('chart-weekdays');
        const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        const counts = [0, 0, 0, 0, 0, 0, 0];

        entries.forEach(e => {
            const d = new Date(e.date + 'T00:00:00').getDay();
            counts[d]++;
        });

        // Reorder to start Monday
        const ordered = [1, 2, 3, 4, 5, 6, 0].map(i => ({ day: days[i], count: counts[i] }));
        const max = Math.max(...ordered.map(d => d.count), 1);

        container.innerHTML = ordered.map(d => {
            const pct = Math.round((d.count / max) * 100);
            const opacity = 0.2 + (d.count / max) * 0.8;
            return `<div class="weekday-col">
                <div class="weekday-bar" style="height:${Math.max(pct, 4)}%;opacity:${opacity}"></div>
                <span class="weekday-label">${d.day}</span>
                <span class="weekday-count">${d.count}</span>
            </div>`;
        }).join('');
    }

    function renderWords(entries) {
        const container = document.getElementById('chart-words');
        const wordCounts = {};

        entries.forEach(e => {
            const texts = [
                e.before?.thoughts || '',
                e.after?.thoughts || '',
                e.behavior || ''
            ].join(' ');

            texts.toLowerCase()
                .replace(/[^a-zàâäéèêëïîôùûüÿç\s'-]/g, '')
                .split(/\s+/)
                .filter(w => w.length > 2 && !STOP_WORDS.has(w))
                .forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });
        });

        const sorted = Object.entries(wordCounts)
            .filter(([, c]) => c >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15);

        if (sorted.length === 0) {
            container.innerHTML = '<p class="trend-empty">Ajoutez des notes et pensées pour voir les thèmes récurrents</p>';
            return;
        }

        const max = sorted[0][1];
        container.innerHTML = sorted.map(([word, count]) => {
            const size = 0.75 + (count / max) * 0.7;
            const opacity = 0.4 + (count / max) * 0.6;
            return `<span class="word-tag" style="font-size:${size}rem;opacity:${opacity}">${word} <sup>${count}</sup></span>`;
        }).join('');
    }

    function getWeekKey(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        const ws = new Date(d);
        ws.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return ws.toISOString().slice(0, 10);
    }

    function renderWeeklyBars(containerId, weekData, formatVal, barColor) {
        const container = document.getElementById(containerId);
        if (weekData.length === 0) {
            container.innerHTML = '<p class="trend-empty">Pas encore de données</p>';
            return;
        }
        const max = Math.max(...weekData.map(w => w.value), 1);
        container.innerHTML = `<div class="evo-bars">${weekData.map(w => {
            const pct = Math.round((w.value / max) * 100);
            const d = new Date(w.week + 'T00:00:00');
            const label = `${d.getDate()}/${d.getMonth() + 1}`;
            return `<div class="evo-col" title="Sem. ${label}: ${formatVal(w.value)}">
                <div class="evo-bar" style="height:${Math.max(pct, 4)}%;background:${barColor || 'var(--primary)'}"></div>
                <span class="evo-val">${formatVal(w.value)}</span>
                <span class="evo-label">${label}</span>
            </div>`;
        }).join('')}</div>`;
    }

    function renderSnackingFrequency(entries) {
        const snacks = entries.filter(e => e.mealType === 'grignotage');
        const weeks = {};
        snacks.forEach(e => {
            const k = getWeekKey(e.date);
            weeks[k] = (weeks[k] || 0) + 1;
        });

        // Fill gaps
        const allWeeks = {};
        entries.forEach(e => { allWeeks[getWeekKey(e.date)] = true; });
        Object.keys(allWeeks).forEach(k => { if (!weeks[k]) weeks[k] = 0; });

        const data = Object.entries(weeks)
            .map(([week, count]) => ({ week, value: count }))
            .sort((a, b) => a.week.localeCompare(b.week))
            .slice(-12);

        renderWeeklyBars('chart-snacking-freq', data, v => v + 'x', 'var(--secondary)');
    }

    function renderSnackingContexts(entries) {
        const container = document.getElementById('chart-snacking-contexts');
        const snacks = entries.filter(e => e.mealType === 'grignotage');
        const counts = {};
        const sitLabels = { maison: 'A la maison', bureau: 'Au bureau', exterieur: 'A l\'extérieur', restaurant: 'Au restaurant', seul: 'Seul(e)', famille: 'En famille', amis: 'Entre amis', collegues: 'Avec collègues', boyfriend: 'Avec boyfriend' };

        snacks.forEach(e => {
            (e.situationChips || []).forEach(s => { counts[s] = (counts[s] || 0) + 1; });
        });

        // Also analyze emotions tied to snacking
        const emotionCounts = {};
        snacks.forEach(e => {
            (e.before?.emotions || []).forEach(em => { emotionCounts[em.name] = (emotionCounts[em.name] || 0) + 1; });
        });

        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const sortedEmotions = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1]).slice(0, 4);

        if (sorted.length === 0 && sortedEmotions.length === 0) {
            container.innerHTML = '<p class="trend-empty">Utilisez les chips de situation lors des grignotages</p>';
            return;
        }

        const max = Math.max(...[...sorted.map(s => s[1]), ...sortedEmotions.map(s => s[1])], 1);
        let html = sorted.map(([name, count]) => {
            const pct = Math.round((count / max) * 100);
            return `<div class="bar-row"><span class="bar-label">${sitLabels[name] || name}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--primary)"></div></div>
                <span class="bar-count">${count}</span></div>`;
        }).join('');

        if (sortedEmotions.length > 0) {
            html += '<p class="trend-subtitle" style="margin-top:12px">Émotions avant grignotage</p>';
            html += sortedEmotions.map(([name, count]) => {
                const pct = Math.round((count / max) * 100);
                return `<div class="bar-row"><span class="bar-label">${EMOTION_LABELS[name] || name}</span>
                    <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--secondary)"></div></div>
                    <span class="bar-count">${count}</span></div>`;
            }).join('');
        }

        container.innerHTML = html;
    }

    function renderGuiltEvolution(entries) {
        const targetEmotions = ['honte', 'culpabilite'];
        const weeks = {};

        entries.forEach(e => {
            const k = getWeekKey(e.date);
            if (!weeks[k]) weeks[k] = { count: 0, totalIntensity: 0, occurrences: 0 };
            weeks[k].count++;
            (e.after?.emotions || []).forEach(em => {
                if (targetEmotions.includes(em.name)) {
                    weeks[k].occurrences++;
                    weeks[k].totalIntensity += em.intensity;
                }
            });
        });

        const data = Object.entries(weeks)
            .map(([week, d]) => ({
                week,
                value: d.occurrences,
                avg: d.occurrences > 0 ? d.totalIntensity / d.occurrences : 0
            }))
            .sort((a, b) => a.week.localeCompare(b.week))
            .slice(-12);

        const container = document.getElementById('chart-guilt');
        if (data.length === 0 || data.every(d => d.value === 0)) {
            container.innerHTML = '<p class="trend-empty">Pas encore de données sur la honte/culpabilité après repas</p>';
            return;
        }

        const max = Math.max(...data.map(w => w.value), 1);
        container.innerHTML = `<div class="evo-bars">${data.map(w => {
            const pct = Math.round((w.value / max) * 100);
            const d = new Date(w.week + 'T00:00:00');
            const label = `${d.getDate()}/${d.getMonth() + 1}`;
            const intensityLabel = w.avg > 0 ? ` (moy. ${w.avg.toFixed(1)}/10)` : '';
            return `<div class="evo-col" title="Sem. ${label}: ${w.value}x${intensityLabel}">
                <div class="evo-bar" style="height:${Math.max(pct, 4)}%;background:var(--danger)"></div>
                <span class="evo-val">${w.value}</span>
                <span class="evo-label">${label}</span>
            </div>`;
        }).join('')}</div>
        <p class="trend-hint" style="margin-top:8px;text-align:center">Nombre de fois par semaine</p>`;
    }

    function renderCravings(entries) {
        const withCraving = entries.filter(e => e.craving === true);
        const satisfied = withCraving.filter(e => e.cravingSatisfied === true);
        const resisted = withCraving.filter(e => e.cravingSatisfied === false);
        const total = entries.length;

        // Summary
        const summaryEl = document.getElementById('chart-cravings-summary');
        if (withCraving.length === 0) {
            summaryEl.innerHTML = '';
            document.getElementById('chart-cravings-freq').innerHTML = '<p class="trend-empty">Renseignez les pulsions sucrées dans le formulaire</p>';
            return;
        }

        const pctCraving = total > 0 ? Math.round((withCraving.length / total) * 100) : 0;
        const pctResisted = withCraving.length > 0 ? Math.round((resisted.length / withCraving.length) * 100) : 0;

        summaryEl.innerHTML = `
            <div class="summary-item"><span class="summary-number">${withCraving.length}</span><span class="summary-label">pulsions</span></div>
            <div class="summary-item"><span class="summary-number" style="color:var(--danger)">${satisfied.length}</span><span class="summary-label">assouvies</span></div>
            <div class="summary-item"><span class="summary-number" style="color:var(--primary)">${resisted.length}</span><span class="summary-label">résistées</span></div>
            <div class="summary-item"><span class="summary-number">${pctResisted}%</span><span class="summary-label">résistance</span></div>`;

        // Weekly frequency with stacked bars
        const weeks = {};
        entries.forEach(e => { const k = getWeekKey(e.date); if (!weeks[k]) weeks[k] = { cravings: 0, satisfied: 0, resisted: 0 }; });
        withCraving.forEach(e => {
            const k = getWeekKey(e.date);
            weeks[k].cravings++;
            if (e.cravingSatisfied === true) weeks[k].satisfied++;
            else weeks[k].resisted++;
        });

        const data = Object.entries(weeks)
            .map(([week, d]) => ({ week, ...d }))
            .sort((a, b) => a.week.localeCompare(b.week))
            .slice(-12);

        const container = document.getElementById('chart-cravings-freq');
        const max = Math.max(...data.map(w => w.cravings), 1);
        container.innerHTML = `<div class="evo-bars">${data.map(w => {
            const pctS = Math.round((w.satisfied / max) * 100);
            const pctR = Math.round((w.resisted / max) * 100);
            const d = new Date(w.week + 'T00:00:00');
            const label = `${d.getDate()}/${d.getMonth() + 1}`;
            return `<div class="evo-col" title="Sem. ${label}: ${w.satisfied} assouvies, ${w.resisted} résistées">
                <div class="evo-stacked" style="height:${Math.max(pctS + pctR, 4)}%">
                    <div class="evo-bar-segment" style="flex:${w.satisfied};background:var(--danger)"></div>
                    <div class="evo-bar-segment" style="flex:${w.resisted};background:var(--primary)"></div>
                </div>
                <span class="evo-val">${w.cravings}</span>
                <span class="evo-label">${label}</span>
            </div>`;
        }).join('')}</div>
        <div class="legend"><span class="legend-dot" style="background:var(--danger)"></span> Assouvies <span class="legend-dot" style="background:var(--primary)"></span> Résistées</div>`;
    }

    function renderBudget(entries) {
        const container = document.getElementById('chart-budget');
        const withPrice = entries.filter(e => e.pastryPrice > 0);

        if (withPrice.length === 0) {
            container.innerHTML = '<p class="trend-empty">Renseignez le prix des pâtisseries pour suivre votre budget</p>';
            return;
        }

        const totalSpent = withPrice.reduce((sum, e) => sum + e.pastryPrice, 0);
        const weeks = {};
        withPrice.forEach(e => {
            const k = getWeekKey(e.date);
            weeks[k] = (weeks[k] || 0) + e.pastryPrice;
        });

        const weekEntries = Object.entries(weeks).sort((a, b) => a[0].localeCompare(b[0]));
        const avgPerWeek = weekEntries.length > 0 ? totalSpent / weekEntries.length : 0;

        const months = {};
        withPrice.forEach(e => {
            const k = e.date.slice(0, 7);
            months[k] = (months[k] || 0) + e.pastryPrice;
        });
        const avgPerMonth = Object.keys(months).length > 0 ? totalSpent / Object.keys(months).length : 0;

        // Current week & month
        const now = new Date();
        const currentWeekKey = getWeekKey(getToday());
        const currentMonthKey = getToday().slice(0, 7);
        const thisWeek = weeks[currentWeekKey] || 0;
        const thisMonth = months[currentMonthKey] || 0;

        container.innerHTML = `
            <div class="budget-row">
                <div class="budget-item">
                    <span class="budget-amount">${thisWeek.toFixed(2)} €</span>
                    <span class="budget-label">cette semaine</span>
                </div>
                <div class="budget-item">
                    <span class="budget-amount">${thisMonth.toFixed(2)} €</span>
                    <span class="budget-label">ce mois</span>
                </div>
            </div>
            <div class="budget-row">
                <div class="budget-item">
                    <span class="budget-amount subtle">${avgPerWeek.toFixed(2)} €</span>
                    <span class="budget-label">moy. / semaine</span>
                </div>
                <div class="budget-item">
                    <span class="budget-amount subtle">${avgPerMonth.toFixed(2)} €</span>
                    <span class="budget-label">moy. / mois</span>
                </div>
            </div>
            <div class="budget-total">
                <span>Total sur la période :</span>
                <strong>${totalSpent.toFixed(2)} €</strong>
                <span class="budget-detail">(${withPrice.length} pâtisserie${withPrice.length > 1 ? 's' : ''})</span>
            </div>`;
    }

    function renderInsights(entries) {
        const container = document.getElementById('insights-list');
        const insights = [];

        if (entries.length < 3) {
            container.innerHTML = '<p class="trend-empty">Continuez à remplir votre journal pour obtenir des observations personnalisées</p>';
            return;
        }

        // Most common emotion before
        const beforeEmotions = countEmotions(entries, 'before');
        if (beforeEmotions.length > 0) {
            const top = beforeEmotions[0];
            const pct = Math.round((top.count / entries.length) * 100);
            insights.push(`Votre émotion la plus fréquente avant les repas est <strong>${EMOTION_LABELS[top.name]}</strong>, présente dans ${pct}% de vos entrées.`);
        }

        // Emotion shift pattern
        const transitions = {};
        entries.forEach(e => {
            const before = e.before?.emotions || [];
            const after = e.after?.emotions || [];
            if (before.length === 0 || after.length === 0) return;
            before.forEach(b => {
                after.forEach(a => {
                    if (b.name !== a.name) {
                        const key = `${b.name}→${a.name}`;
                        transitions[key] = (transitions[key] || 0) + 1;
                    }
                });
            });
        });
        const topTransition = Object.entries(transitions).sort((a, b) => b[1] - a[1])[0];
        if (topTransition && topTransition[1] >= 2) {
            const [from, to] = topTransition[0].split('→');
            insights.push(`Pattern récurrent : quand vous ressentez <strong>${EMOTION_LABELS[from]}</strong> avant le repas, vous ressentez souvent <strong>${EMOTION_LABELS[to]}</strong> après (${topTransition[1]} fois).`);
        }

        // Most common meal with negative emotions
        const negativeEmotions = ['tristesse', 'peur', 'colere', 'degout', 'culpabilite', 'honte', 'stress', 'frustration'];
        const mealNegative = {};
        entries.forEach(e => {
            const hasNeg = (e.before?.emotions || []).some(em => negativeEmotions.includes(em.name));
            if (hasNeg && e.mealType) {
                mealNegative[e.mealType] = (mealNegative[e.mealType] || 0) + 1;
            }
        });
        const topNegMeal = Object.entries(mealNegative).sort((a, b) => b[1] - a[1])[0];
        if (topNegMeal && topNegMeal[1] >= 2) {
            insights.push(`Les émotions difficiles sont plus fréquentes au <strong>${MEAL_LABELS[topNegMeal[0]]}</strong> (${topNegMeal[1]} fois).`);
        }

        // Situation with most negative emotions
        const sitNeg = {};
        const sitLabels = { maison: 'à la maison', bureau: 'au bureau', exterieur: 'à l\'extérieur', restaurant: 'au restaurant', seul: 'seul(e)', famille: 'en famille', amis: 'entre amis', collegues: 'avec vos collègues', boyfriend: 'avec votre boyfriend' };
        entries.forEach(e => {
            const hasNeg = (e.before?.emotions || []).some(em => negativeEmotions.includes(em.name));
            if (hasNeg) (e.situationChips || []).forEach(s => { sitNeg[s] = (sitNeg[s] || 0) + 1; });
        });
        const topSitNeg = Object.entries(sitNeg).sort((a, b) => b[1] - a[1])[0];
        if (topSitNeg && topSitNeg[1] >= 2) {
            insights.push(`Les émotions difficiles apparaissent souvent quand vous êtes <strong>${sitLabels[topSitNeg[0]] || topSitNeg[0]}</strong>.`);
        }

        // Snacking patterns
        const snacks = entries.filter(e => e.mealType === 'grignotage');
        if (snacks.length >= 2) {
            const snackSit = {};
            const snackLabels = { maison: 'à la maison', bureau: 'au bureau', exterieur: 'à l\'extérieur', restaurant: 'au restaurant', seul: 'seul(e)', famille: 'en famille', amis: 'entre amis', collegues: 'avec vos collègues', boyfriend: 'avec votre boyfriend' };
            snacks.forEach(e => { (e.situationChips || []).forEach(s => { snackSit[s] = (snackSit[s] || 0) + 1; }); });
            const topSnackSit = Object.entries(snackSit).sort((a, b) => b[1] - a[1])[0];
            if (topSnackSit && topSnackSit[1] >= 2) {
                insights.push(`Vos grignotages ont lieu le plus souvent <strong>${snackLabels[topSnackSit[0]] || topSnackSit[0]}</strong> (${topSnackSit[1]} fois).`);
            }

            const snackEmo = {};
            snacks.forEach(e => { (e.before?.emotions || []).forEach(em => { snackEmo[em.name] = (snackEmo[em.name] || 0) + 1; }); });
            const topSnackEmo = Object.entries(snackEmo).sort((a, b) => b[1] - a[1])[0];
            if (topSnackEmo && topSnackEmo[1] >= 2) {
                insights.push(`L'émotion qui déclenche le plus souvent un grignotage est <strong>${EMOTION_LABELS[topSnackEmo[0]]}</strong> (${topSnackEmo[1]} fois).`);
            }
        }

        // Craving patterns
        const cravings = entries.filter(e => e.craving === true);
        if (cravings.length >= 2) {
            const satisfied = cravings.filter(e => e.cravingSatisfied === true);
            const resisted = cravings.filter(e => e.cravingSatisfied === false);
            const totalSpent = satisfied.reduce((s, e) => s + (e.pastryPrice || 0), 0);

            insights.push(`Vous avez eu <strong>${cravings.length} pulsions sucrées</strong> sur la période : ${satisfied.length} assouvie${satisfied.length > 1 ? 's' : ''}, ${resisted.length} résistée${resisted.length > 1 ? 's' : ''}.`);

            if (totalSpent > 0) {
                insights.push(`Budget pâtisseries : <strong>${totalSpent.toFixed(2)} €</strong> dépensés sur la période.`);
            }
        }

        // Guilt/shame trend
        const guiltAfter = entries.filter(e =>
            (e.after?.emotions || []).some(em => em.name === 'honte' || em.name === 'culpabilite')
        );
        if (guiltAfter.length >= 2) {
            const pct = Math.round((guiltAfter.length / entries.length) * 100);
            insights.push(`Honte ou culpabilité après repas dans <strong>${pct}%</strong> de vos entrées (${guiltAfter.length}/${entries.length}).`);
        }

        if (insights.length === 0) {
            container.innerHTML = '<p class="trend-empty">Pas encore assez de données pour des observations</p>';
            return;
        }

        container.innerHTML = insights.map(i => `<div class="insight-item">${i}</div>`).join('');
    }

    function avgIntensity(entries) {
        let sum = 0, count = 0;
        entries.forEach(e => {
            (e.before?.emotions || []).forEach(em => { sum += em.intensity; count++; });
        });
        return count > 0 ? sum / count : 0;
    }

    // ===== INIT =====

    async function init() {
        try {
            await firestore.enablePersistence({ synchronizeTabs: true });
        } catch (e) {
            if (e.code !== 'failed-precondition' && e.code !== 'unimplemented') {
                console.warn('Offline persistence error:', e);
            }
        }

        auth.onAuthStateChanged(async (user) => {
            if (user) {
                currentUser = user;
                hideLoginScreen();

                await migrateIfNeeded();

                initChips();
                initSpeech();
                loadTodayEntries();
            } else {
                currentUser = null;
                showLoginScreen();
            }
        });

        if ('serviceWorker' in navigator) {
            try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* optional */ }
        }
    }

    document.addEventListener('DOMContentLoaded', init);

    return {
        navigate, showForm, goBack, saveEntry, deleteEntry,
        showDetail, editFromDetail, startSpeech, stopSpeech,
        prevMonth, nextMonth, selectDate,
        exportJSON, exportCSV, exportPrint, importJSON, handleImport,
        toggleSection, quickNormalEntry, duplicateLastEntry, duplicateEntry,
        setPeriod, setCraving, setCravingSatisfied,
        loginWithGoogle, logout
    };
})();
