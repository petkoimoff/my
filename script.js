document.addEventListener('DOMContentLoaded', function() {
    // --- Глобално състояние и DOM елементи ---
    let tasks = [];
    let selectedDate = new Date().toISOString().split('T')[0]; // По подразбиране е днес

    const calendarEl = document.getElementById('calendar-container');
    const taskForm = document.getElementById('add-task-form');
    const taskInput = document.getElementById('task-input');
    const taskDateInput = document.getElementById('task-date');
    const taskTimeInput = document.getElementById('task-time');
    const taskList = document.getElementById('task-list');
    const tasksHeader = document.getElementById('tasks-header');
    const notificationsBtn = document.getElementById('enable-notifications-btn');
    const dictateBtn = document.getElementById('dictate-btn');

    // --- Инициализация на календара ---
    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'bg', // Локализация на български
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay'
        },
        events: (fetchInfo, successCallback) => {
            // Динамично зареждане на задачите като събития
            const calendarEvents = tasks.map(task => ({
                title: task.text,
                start: task.date + (task.time ? `T${task.time}` : ''),
                id: task.id.toString()
            }));
            successCallback(calendarEvents);
        },
        dateClick: (info) => {
            // Обработка на клик върху дата
            selectedDate = info.dateStr;
            taskDateInput.value = selectedDate;
            updateTasksView();
        }
    });
    calendar.render();

    // --- Запазване и зареждане на данни (LocalStorage) ---
    function loadTasks() {
        const storedTasks = localStorage.getItem('tasks');
        if (storedTasks) {
            tasks = JSON.parse(storedTasks);
        }
    }

    function saveTasks() {
        localStorage.setItem('tasks', JSON.stringify(tasks));
    }

    // --- Рендиране на задачите и актуализиране на изгледа ---
    function updateTasksView() {
        const date = new Date(selectedDate + 'T00:00:00');
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        tasksHeader.textContent = `Задачи за ${date.toLocaleDateString('bg-BG', options)}`;

        taskList.innerHTML = '';
        const dailyTasks = tasks.filter(task => task.date === selectedDate).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
        dailyTasks.forEach(createTaskElement);
    }

    function createTaskElement(task) {
        const listItem = document.createElement('li');
        listItem.setAttribute('data-id', task.id);

        const taskSpan = document.createElement('span');
        taskSpan.textContent = task.time ? `${task.time} - ${task.text}` : task.text;
        listItem.appendChild(taskSpan);

        const buttonsContainer = document.createElement('div');

        const editButton = document.createElement('button');
        editButton.textContent = '✏️';
        editButton.title = 'Редактирай';
        editButton.onclick = () => editTask(task.id);
        buttonsContainer.appendChild(editButton);

        const deleteButton = document.createElement('button');
        deleteButton.textContent = '❌';
        deleteButton.title = 'Изтрий';
        deleteButton.onclick = () => deleteTask(task.id);
        buttonsContainer.appendChild(deleteButton);

        listItem.appendChild(buttonsContainer);
        taskList.appendChild(listItem);
    }

    // --- CRUD операции ---
    function addNewTask(text, date, time) {
        if (text.trim() === '' || !date) {
            alert('Моля, въведете текст на задачата и изберете дата.');
            return;
        }
        const task = { id: Date.now(), text, date, time: time || null, notified: false };
        tasks.push(task);
        saveTasks();
        calendar.refetchEvents();
        updateTasksView();
    }

    function editTask(taskId) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        const newText = prompt('Редактирайте задачата:', task.text);
        if (newText !== null && newText.trim() !== '') {
            task.text = newText;
            saveTasks();
            calendar.refetchEvents();
            updateTasksView();
        }
    }

    function deleteTask(taskId) {
        if (confirm('Сигурни ли сте, че искате да изтриете тази задача?')) {
            tasks = tasks.filter(t => t.id !== taskId);
            saveTasks();
            calendar.refetchEvents();
            updateTasksView();
        }
    }

    // --- Гласово въвеждане ---
    if ('webkitSpeechRecognition' in window) {
        const recognition = new webkitSpeechRecognition();
        recognition.lang = 'bg-BG';
        recognition.continuous = false;
        recognition.interimResults = false;

        dictateBtn.addEventListener('click', () => recognition.start());
        recognition.onresult = (event) => {
            taskInput.value = event.results[0][0].transcript;
        };
        recognition.onerror = (event) => console.error('Грешка при разпознаване на реч:', event.error);
    } else {
        dictateBtn.style.display = 'none';
    }

    // --- Система за известия ---
    let notificationInterval;

    function checkUpcomingTasks() {
        const now = new Date();
        tasks.forEach(task => {
            if (task.date && task.time && !task.notified) {
                const taskTime = new Date(`${task.date}T${task.time}`);
                const diff = (taskTime - now) / 1000;

                if (diff > 0 && diff <= 300) {
                    showNotification(`Предстояща задача: ${task.text} в ${task.time}`);
                    task.notified = true;
                    saveTasks();
                }
            }
        });
    }

    notificationsBtn.addEventListener('click', () => {
        if (Notification.permission === 'granted') {
             alert('Известията са вече активирани.');
             return;
        }
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                notificationsBtn.textContent = 'Известията са активни';
                notificationsBtn.style.backgroundColor = '#218838';
                showNotification('Системата за известия е успешно активирана!');
                notificationInterval = setInterval(checkUpcomingTasks, 15000);
            }
        });
    });

    function showNotification(message) {
        new Notification('Мениджър на задачи', { body: message, icon: './icon.png' });
    }

    // --- Инициализация на приложението ---
    function initializeApp() {
        loadTasks();
        taskDateInput.value = selectedDate;
        if (Notification.permission === 'granted') {
            notificationsBtn.textContent = 'Известията са активни';
            notificationsBtn.style.backgroundColor = '#218838';
            notificationInterval = setInterval(checkUpcomingTasks, 15000);
        }
        calendar.refetchEvents();
        updateTasksView();
    }

    taskForm.addEventListener('submit', (event) => {
        event.preventDefault();
        addNewTask(taskInput.value, taskDateInput.value, taskTimeInput.value);
        taskInput.value = '';
    });

    initializeApp();
});