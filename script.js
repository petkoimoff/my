/**
 * PostVai.com Chat Assistant
 * This script contains all the necessary logic for the chat application, including:
 * - ChatUI: Manages the user interface and interactions.
 * - RAGChatSystem: Handles the core logic of fetching, processing, and ranking posts.
 * - PostVaiChatApp: The main application class that orchestrates the UI and RAG system.
 */

// ===================================================================================
// CLASS 1: RAG (Retrieval-Augmented Generation) System
// Handles fetching data from PostVai.com, processing it, and finding answers.
// ===================================================================================
class RAGChatSystem {
    constructor() {
        this.apiBaseUrl = 'https://postvai.com/wp-json/wp/v2';
        this.queryCache = new Map();
        this.cacheExpiry = 30 * 60 * 1000; // 30 минути
    }

    /**
     * Searches posts on the WordPress server using the search parameter.
     * This is much more efficient than fetching all posts.
     */
    async searchPosts(query) {
        const url = new URL(`${this.apiBaseUrl}/posts`);
        url.searchParams.set('search', query);
        url.searchParams.set('per_page', '20'); // Get top 20 results from WP search
        url.searchParams.set('_fields', 'id,title,content,link,excerpt,date');
        url.searchParams.set('status', 'publish');

        try {
            const response = await fetch(url.toString());
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('Грешка при директно търсене:', error);
            if (error.message.includes('CORS') || error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
                console.log('Опит за търсене с CORS proxy...');
                return this.searchWithCorsProxy(query);
            }
            throw new Error('Не мога да извърша търсене в момента.');
        }
    }

    /**
     * Резервен метод за търсене с CORS proxy.
     */
    async searchWithCorsProxy(query) {
        try {
            const proxyUrl = 'https://api.allorigins.win/get?url=';
            const targetUrl = encodeURIComponent(`${this.apiBaseUrl}/posts?search=${query}&per_page=20&_fields=id,title,content,link,excerpt,date&status=publish`);

            const response = await fetch(proxyUrl + targetUrl);
            const data = await response.json();

            if (data.contents) {
                return JSON.parse(data.contents);
            }
            throw new Error('Празен отговор от CORS proxy');
        } catch (error) {
            console.error('Грешка при CORS proxy търсене:', error);
            return [];
        }
    }

    /**
     * Почистване на HTML съдържание до чист текст.
     */
    cleanHtml(htmlText) {
        if (!htmlText) return "";
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlText;
        const scripts = tempDiv.querySelectorAll('script, style');
        scripts.forEach(el => el.remove());
        let text = tempDiv.textContent || tempDiv.innerText || "";
        return text
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
            .replace(/&hellip;/g, '...').replace(/\s+/g, ' ').trim();
    }

    /**
     * Подготовка на текст за обработка (токенизация, малки букви и т.н.).
     */
    preprocessText(text) {
        return text.toLowerCase()
            .replace(/[^\u0400-\u04FF\w\s]/g, ' ') // Запазване на кирилица и латиница
            .replace(/\s+/g, ' ').trim().split(/\s+/)
            .filter(word => word.length > 2);
    }

    /**
     * Създаване на TF-IDF вектори от документи.
     */
    createTfIdfVectors(documents) {
        const processedDocs = documents.map(doc => this.preprocessText(doc));
        const vocabulary = new Set(processedDocs.flat());
        const vocabArray = Array.from(vocabulary);
        const docCount = processedDocs.length;

        const idfMap = new Map();
        vocabArray.forEach(word => {
            const docFreq = processedDocs.filter(doc => doc.includes(word)).length;
            idfMap.set(word, Math.log(docCount / (1 + docFreq)));
        });

        const vectors = processedDocs.map(words => {
            const vector = new Array(vocabArray.length).fill(0);
            const wordCount = new Map();
            words.forEach(word => wordCount.set(word, (wordCount.get(word) || 0) + 1));

            vocabArray.forEach((word, index) => {
                if (wordCount.has(word)) {
                    const tf = wordCount.get(word) / words.length;
                    vector[index] = tf * idfMap.get(word);
                }
            });
            return vector;
        });

        return { vectors, vocabulary: vocabArray };
    }

    /**
     * Изчисляване на косинусово сходство между два вектора.
     */
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Ранжиране на намерените публикации чрез TF-IDF и косинусово сходство.
     */
    async rankRelevantPosts(query, posts, topK = 5) {
        if (!posts || posts.length === 0) return [];

        try {
            const postTexts = posts.map(post => {
                const title = this.cleanHtml(post.title?.rendered || '');
                const content = this.cleanHtml(post.content?.rendered || '');
                return `${title} ${content}`;
            });

            const allTexts = [...postTexts, query];
            const { vectors } = this.createTfIdfVectors(allTexts);
            const queryVector = vectors.pop();

            const similarities = vectors.map((postVector, index) => ({
                index,
                similarity: this.cosineSimilarity(queryVector, postVector),
                post: posts[index]
            }));

            similarities.sort((a, b) => b.similarity - a.similarity);

            return similarities
                .filter(item => item.similarity > 0.01) // По-нисък праг, тъй като WP search вече е филтрирал
                .slice(0, topK)
                .map(item => ({ ...item.post, similarity_score: item.similarity }));
        } catch (error) {
            console.error('Грешка при ранжиране на публикации:', error);
            return [];
        }
    }

    /**
     * Генериране на отговор на базата на релевантните публикации.
     */
    generateResponse(query, relevantPosts) {
        if (!relevantPosts || relevantPosts.length === 0) {
            return {
                answer: 'За съжаление не намерих релевантна информация по този въпрос в публикациите на PostVai.com. Моля, опитайте с различни ключови думи.',
                sources: []
            };
        }

        const sources = relevantPosts.map(post => ({
            title: this.cleanHtml(post.title?.rendered || ''),
            link: post.link || '',
            similarity: post.similarity_score || 0,
            date: post.date ? new Date(post.date).toLocaleDateString('bg-BG') : ''
        }));

        const answerParts = [`🔍 Намерих ${relevantPosts.length} релевантни публикации, които може да отговорят на въпроса ви:`];
        relevantPosts.forEach((post, index) => {
            const title = this.cleanHtml(post.title?.rendered || '');
            const excerpt = this.cleanHtml(post.excerpt?.rendered || '');
            answerParts.push(`\n**${index + 1}. ${title}**`);
            answerParts.push(excerpt || 'Няма налично резюме.');
        });
        answerParts.push("\n📚 За пълна информация, моля посетете линковете към публикациите.");

        return { answer: answerParts.join('\n'), sources: sources };
    }

    /**
     * Главна функция за обработка на заявки.
     */
    async processQuery(question) {
        const cached = this.queryCache.get(question);
        if (cached && (Date.now() - cached.timestamp < this.cacheExpiry)) {
            console.log("Връщам кеширан отговор за:", question);
            return cached.response;
        }

        try {
            if (!question || question.trim().length < 3) {
                return { answer: 'Моля, задайте по-конкретен въпрос (поне 3 символа).', sources: [] };
            }

            console.log('Търся публикации за:', question);
            const posts = await this.searchPosts(question);

            if (!posts || posts.length === 0) {
                return { answer: 'Не открих публикации, свързани с вашето търсене.', sources: [] };
            }

            console.log(`Намерени ${posts.length} възможни публикации. Ранжирам...`);
            const rankedPosts = await this.rankRelevantPosts(question, posts, 5);
            const response = this.generateResponse(question, rankedPosts);

            this.queryCache.set(question, { response, timestamp: Date.now() });
            console.log(`Намерени ${rankedPosts.length} релевантни публикации.`);
            return response;

        } catch (error) {
            console.error('Грешка при обработка на заявката:', error);
            return { answer: 'Възникна техническа грешка при търсенето. Моля, опитайте отново.', sources: [] };
        }
    }
}


// ===================================================================================
// CLASS 2: Chat UI Manager
// Handles all DOM manipulations and user interface events.
// ===================================================================================
class ChatUI {
    constructor() {
        this.chatMessages = document.getElementById('chatMessages');
        this.chatForm = document.getElementById('chatForm');
        this.chatInput = document.getElementById('chatInput');
        this.sendButton = document.getElementById('sendButton');
        this.statusIndicator = document.getElementById('statusIndicator');
        this.charCounter = document.getElementById('charCounter');
        this.toastContainer = document.getElementById('toastContainer');

        this.initializeEventListeners();
        this.updateCharCounter();
        this.addWelcomeMessage();
    }

    initializeEventListeners() {
        this.chatForm.addEventListener('submit', e => { e.preventDefault(); this.handleSendMessage(); });
        this.chatInput.addEventListener('keypress', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSendMessage(); } });
        this.chatInput.addEventListener('input', () => { this.updateCharCounter(); this.autoResizeInput(); });
        this.chatInput.focus();
    }

    autoResizeInput() {
        this.chatInput.style.height = 'auto';
        this.chatInput.style.height = `${Math.min(this.chatInput.scrollHeight, 120)}px`;
    }

    updateCharCounter() {
        const len = this.chatInput.value.length;
        const max = this.chatInput.maxLength;
        this.charCounter.textContent = len;
        this.charCounter.parentElement.style.color = len > max * 0.8 ? '#f44336' : '#999';
    }

    setStatus(status, message = '') {
        const colors = { ready: '#4CAF50', processing: '#ff9800', error: '#f44336' };
        this.statusIndicator.style.background = colors[status] || colors.ready;
        this.statusIndicator.title = message;
    }

    async handleSendMessage() {
        const question = this.chatInput.value.trim();
        if (question.length < 3) {
            this.showToast('Въпросът трябва да е поне 3 символа', 'warning');
            return;
        }

        this.addMessage(question, 'user');
        this.chatInput.value = '';
        this.updateCharCounter();
        this.autoResizeInput();

        this.setLoading(true);
        this.setStatus('processing', 'Търся информация...');
        const loadingId = this.addLoadingMessage();

        try {
            if (window.chatApp && typeof window.chatApp.processQuery === 'function') {
                const response = await window.chatApp.processQuery(question);
                this.removeMessage(loadingId);
                this.addMessage(response.answer, 'bot', response.sources);
                this.setStatus('ready', 'Системата е готова');
            } else {
                throw new Error('Чат системата не е инициализирана.');
            }
        } catch (error) {
            console.error('Грешка при изпращане:', error);
            this.removeMessage(loadingId);
            this.addMessage('Възникна грешка при обработката на заявката.', 'bot');
            this.setStatus('error', error.message);
            this.showToast('Възникна грешка', 'error');
        } finally {
            this.setLoading(false);
            this.chatInput.focus();
        }
    }

    addMessage(content, sender, sources = null) {
        const welcomeMessage = this.chatMessages.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.style.animation = 'fadeOut 0.3s ease-out forwards';
            setTimeout(() => welcomeMessage.remove(), 300);
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;
        messageDiv.innerHTML = `
            <div class="message-bubble">
                ${this.formatContent(content)}
                ${sender === 'bot' && sources && sources.length > 0 ? this.createSourcesElement(sources) : ''}
                ${sender === 'bot' ? `<div class="message-timestamp">${new Date().toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
            </div>
        `;
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }

    createSourcesElement(sources) {
        const sourcesList = sources.map((source, index) => `
            <div class="source-item">
                <a href="${source.link}" target="_blank" rel="noopener noreferrer">${index + 1}. ${source.title}</a>
                <div style="margin-top: 4px; font-size: 0.75rem; color: #666;">
                    <span class="similarity-score">Релевантност: ${Math.round(source.similarity * 100)}%</span>
                    ${source.date ? `<span> • Дата: ${source.date}</span>` : ''}
                </div>
            </div>
        `).join('');
        return `<div class="sources"><h4>Източници от PostVai.com:</h4>${sourcesList}</div>`;
    }

    addLoadingMessage() {
        const id = `loading_${Date.now()}`;
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot';
        messageDiv.id = id;
        messageDiv.innerHTML = `
            <div class="message-bubble">
                <div class="loading">
                    <span>🔍 Търся в публикациите на PostVai.com...</span>
                    <div class="loading-dots">
                        <div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div>
                    </div>
                </div>
            </div>`;
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
        return id;
    }

    removeMessage(id) {
        const message = document.getElementById(id);
        if (message) {
            message.style.animation = 'fadeOut 0.3s ease-out forwards';
            setTimeout(() => message.remove(), 300);
        }
    }

    formatContent(content) {
        return content
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    }

    setLoading(isLoading) {
        this.sendButton.disabled = isLoading;
        this.chatInput.disabled = isLoading;
        this.sendButton.querySelector('.button-text').textContent = isLoading ? 'Изпраща...' : 'Изпрати';
        this.sendButton.querySelector('.button-icon').textContent = isLoading ? '⏳' : '📤';
    }

    scrollToBottom() {
        requestAnimationFrame(() => { this.chatMessages.scrollTop = this.chatMessages.scrollHeight; });
    }

    showToast(message, type = 'info', duration = 4000) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        this.toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease-out forwards';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    addWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = `
            <div class="welcome-icon">🤖</div>
            <h3>Добре дошли в чат асистента!</h3>
            <p>Задайте въпрос и ще получите отговор на базата на публикациите в PostVai.com.</p>
            <div class="example-questions">
                <h4>💡 Примерни въпроси:</h4>
                <div class="example-grid">
                    <button class="example-question" onclick="askExample('Какво е дезинформация?')">🔍 Какво е дезинформация?</button>
                    <button class="example-question" onclick="askExample('Как да разпознаем фалшивите новини?')">⚠️ Как да разпознаем фалшивите новини?</button>
                    <button class="example-question" onclick="askExample('Последствия от дезинформацията?')">📊 Последствия от дезинформацията?</button>
                    <button class="example-question" onclick="askExample('Медийна грамотност?')">📚 Медийна грамотност?</button>
                </div>
            </div>`;
        this.chatMessages.appendChild(welcomeDiv);
    }
}


// ===================================================================================
// CLASS 3: Main Chat Application
// Orchestrates the RAG system and the UI.
// ===================================================================================
class PostVaiChatApp {
    constructor() {
        this.ragSystem = new RAGChatSystem();
        this.chatUI = new ChatUI();
        window.chatApp = this; // Make it globally accessible for the UI
        this.chatUI.setStatus('ready', 'Системата е готова за въпроси');
        console.log('✅ Чат асистентът е готов за използване.');
    }

    async processQuery(question) {
        const startTime = Date.now();
        const response = await this.ragSystem.processQuery(question);
        const processingTime = Date.now() - startTime;
        console.log(`✅ Заявката е обработена за ${processingTime}ms`);
        return response;
    }
}

// ===================================================================================
// GLOBAL FUNCTIONS & INITIALIZATION
// ===================================================================================

/**
 * Функция, която се извиква от бутоните за примерни въпроси.
 */
function askExample(question) {
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.value = question;
        chatInput.focus();
        // Manually trigger input event to update counter and size
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

/**
 * Инициализация на приложението при зареждане на страницата.
 */
document.addEventListener('DOMContentLoaded', () => {
    new PostVaiChatApp();
});
