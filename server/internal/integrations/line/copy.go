package line

// copyText is the bot's own text for one language. LINE is used mostly in
// Japan, Taiwan and Thailand, so the copy is chosen per installation
// (ja, en or zh-Hant) instead of being English only.
type copyText struct {
	// BindPrompt is followed by a newline and the bind URL.
	BindPrompt     string
	BindExpiry     string
	BindInGroup    string
	Hello          string
	Joined         string
	Unsupported    string
	WorkingOnIt    string
	Continued      string
	FreshPending   string
	ChatStarted    string
	IssueUsage     string
	IssueNotMember string
	IssueDisabled  string
	// IssueCreated and IssueDuplicate take the issue identifier and an
	// optional " title" suffix through fmt.Sprintf.
	IssueCreated   string
	IssueDuplicate string
}

var copies = map[Language]copyText{
	LanguageEnglish: {
		BindPrompt:     "To chat with me, link your LINE account to Multica:",
		BindExpiry:     "(This link expires in 15 minutes.)",
		BindInGroup:    "Message me 1:1 first to link your LINE account to Multica, then mention me here again.",
		Hello:          "Hi! Send me a message to start a Multica chat.",
		Joined:         "Thanks for adding me. Mention me (@) in this group to ask something.",
		Unsupported:    "I can only read text messages for now.",
		WorkingOnIt:    "Working on it… I'll send the answer here when it's ready.",
		Continued:      "… continued in Multica:",
		FreshPending:   "Fresh start ready. Your next message will run without previous context.",
		ChatStarted:    "Started a new Multica chat. Your next message will enter it.",
		IssueUsage:     "Please include an issue title. Use:\n\n/issue <title>\n[description] (optional)",
		IssueNotMember: "You're not a member of this Multica workspace, so I can't file an issue for you. Ask a workspace admin to invite you, then send the command again.",
		IssueDisabled:  "This LINE bot isn't connected to Multica (or was disconnected). Ask a workspace admin to reconnect it.",
		IssueCreated:   "Created %s%s",
		IssueDuplicate: "Not created: active issue %s already exists%s",
	},
	LanguageJapanese: {
		BindPrompt:     "チャットを始めるには、LINE アカウントを Multica に連携してください：",
		BindExpiry:     "（このリンクの有効期限は 15 分です）",
		BindInGroup:    "まず 1 対 1 のトークで LINE アカウントを Multica に連携してから、もう一度このグループでメンションしてください。",
		Hello:          "こんにちは。メッセージを送ると Multica のチャットが始まります。",
		Joined:         "追加ありがとうございます。このグループでは @ でメンションして質問してください。",
		Unsupported:    "現在はテキストメッセージのみ読み取れます。",
		WorkingOnIt:    "対応中です… 回答ができたらここに送ります。",
		Continued:      "… 続きは Multica で：",
		FreshPending:   "新しく始める準備ができました。次のメッセージは以前の文脈なしで実行されます。",
		ChatStarted:    "Multica で新しいチャットを始めました。次のメッセージはこのチャットに入ります。",
		IssueUsage:     "タスクのタイトルを入力してください：\n\n/issue <タイトル>\n[説明]（任意）",
		IssueNotMember: "この Multica ワークスペースのメンバーではないため、タスクを作成できません。ワークスペースの管理者に招待してもらってから、もう一度コマンドを送ってください。",
		IssueDisabled:  "この LINE bot は Multica に接続されていません（または接続が解除されました）。ワークスペースの管理者に再接続を依頼してください。",
		IssueCreated:   "%s を作成しました%s",
		IssueDuplicate: "作成しませんでした：進行中のタスク %s がすでにあります%s",
	},
	LanguageTraditionalChinese: {
		BindPrompt:     "要開始對話，請將你的 LINE 帳號連結到 Multica：",
		BindExpiry:     "（此連結 15 分鐘後失效）",
		BindInGroup:    "請先在 1 對 1 聊天中將 LINE 帳號連結到 Multica，再回到這個群組提及我。",
		Hello:          "你好！傳訊息給我就能開始 Multica 對話。",
		Joined:         "感謝邀請。在這個群組中用 @ 提及我即可提問。",
		Unsupported:    "目前只能讀取文字訊息。",
		WorkingOnIt:    "處理中… 回覆完成後會傳到這裡。",
		Continued:      "… 在 Multica 繼續閱讀：",
		FreshPending:   "已準備重新開始。下一則訊息將不帶先前的脈絡執行。",
		ChatStarted:    "已在 Multica 開始新對話。下一則訊息會進入這個對話。",
		IssueUsage:     "請輸入任務標題：\n\n/issue <標題>\n[說明]（選填）",
		IssueNotMember: "你不是這個 Multica 工作區的成員，所以無法替你建立任務。請工作區管理員邀請你後，再傳一次指令。",
		IssueDisabled:  "這個 LINE bot 尚未連接到 Multica（或已中斷連接）。請工作區管理員重新連接。",
		IssueCreated:   "已建立 %s%s",
		IssueDuplicate: "未建立：已有進行中的任務 %s%s",
	},
}

// textFor returns the copy for a language, falling back to the default.
func textFor(lang Language) copyText {
	if c, ok := copies[lang]; ok {
		return c
	}
	return copies[DefaultLanguage]
}
