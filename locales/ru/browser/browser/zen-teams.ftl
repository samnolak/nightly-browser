# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Sharing with the team through Ombra (B1, B2)

zen-team-share-page =
    .label = Поделиться страницей с командой…
zen-team-share-tab =
    .label = Поделиться вкладкой с командой…
zen-team-share-group =
    .label = Поделиться группой вкладок с командой…

# $reason: why Ombra cannot share now
zen-team-unavailable =
    .label =
        { $reason ->
            [untrusted] Нельзя поделиться: не удалось проверить Ombra на этом Mac
            [signed-out] Нельзя поделиться: войдите в команду в Ombra
            [no-team] Нельзя поделиться: создайте команду в Ombra или вступите в неё
            [not-ready] Нельзя поделиться: Ombra ещё загружает команду
            [no-members] Нельзя поделиться: в команде пока нет других участников
           *[other] Нельзя поделиться: откройте Ombra на этом Mac
        }
zen-team-unavailable-toast =
    { $reason ->
        [untrusted] Не удалось проверить Ombra на этом Mac
        [signed-out] Чтобы поделиться, войдите в команду в Ombra
        [no-team] Чтобы поделиться, создайте команду в Ombra или вступите в неё
        [not-ready] Ombra ещё загружает команду
        [no-members] В команде пока нет других участников
       *[other] Чтобы поделиться с командой, откройте Ombra на этом Mac
    }

zen-team-share-dialog =
    .title = Поделиться с командой
    .buttonlabelaccept = Отправить
zen-team-share-title = Поделиться с командой
zen-team-share-what-link = Страница: { $title }
zen-team-share-what-screenshot = Снимок: { $title }
zen-team-share-what-collection =
    { $count ->
        [one] Группа вкладок «{ $title }», { $count } вкладка
        [few] Группа вкладок «{ $title }», { $count } вкладки
       *[many] Группа вкладок «{ $title }», { $count } вкладок
    }
# $names: the parameter names, comma separated
zen-team-share-secrets = Похоже, в адресе есть секрет ({ $names }). Любой получатель сможет им воспользоваться.
zen-team-share-strip = Убрать эти параметры перед отправкой
zen-team-share-comment =
    .placeholder = Комментарий (необязательно)
zen-team-share-team = Команда
zen-team-share-to = Кому
zen-team-share-to-all =
    { $count ->
        [one] Всем в команде ({ $count } участник)
        [few] Всем в команде ({ $count } участника)
       *[many] Всем в команде ({ $count } участников)
    }
zen-team-share-to-members = Выбранным участникам
zen-team-share-sending = Отправка через Ombra…
# $reason: an error code from Ombra; $detail: its explanation
zen-team-share-failed =
    { $reason ->
        [not-running] Ombra перестала отвечать. Откройте Ombra и попробуйте снова.
        [untrusted] Не удалось проверить Ombra на этом Mac.
        [timeout] Ombra не ответила вовремя. Попробуйте снова.
        [too-large] Это слишком большой объём, чтобы поделиться.
       *[other] Не удалось поделиться: { $detail }
    }

zen-team-shared =
    { $count ->
        [one] Отправлено { $count } участнику
       *[other] Отправлено { $count } участникам
    }

## Toasts for what team members shared. $author: who shared; $title: what

zen-team-incoming-link = { $author } поделился(-ась) ссылкой «{ $title }»
zen-team-incoming-collection = { $author } поделился(-ась) коллекцией «{ $title }»
zen-team-incoming-screenshot = { $author } поделился(-ась) снимком «{ $title }»
zen-team-toast-open =
    .label = Открыть
zen-team-open-failed = Не удалось открыть. Ombra запущена?
