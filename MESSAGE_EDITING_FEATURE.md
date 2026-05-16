# Message Editing Feature Implementation

## Overview
This document describes the message editing feature that has been implemented in PingUp. Users can now edit their own messages inline, with visibility of edit history and real-time updates for all participants in the conversation.

## Features

### 1. **Edit Messages**
- **Authors can edit their own messages** - Original message authors can click the edit button (✏️) to modify their sent messages
- **Moderators can edit any message** - Owners and moderators have the ability to edit messages from any user
- **Inline editing** - Messages can be edited directly in the chat interface without leaving the conversation
- **Edit indication** - When a message has been edited, an "(edited)" tag appears next to the timestamp

### 2. **Edit History Tracking**
- **Complete history preserved** - Every edit is logged with:
  - Original text before edit
  - New text after edit
  - Timestamp of the edit
  - Editor information (shows if edited by moderator vs author)
- **View history modal** - Click on the "(edited)" tag to see the full edit history of a message
- **Visual timeline** - Edit history is displayed in chronological order with timestamps

### 3. **Real-time Updates**
- **Instant propagation** - When a message is edited, all participants see the update immediately
- **Real-time synchronization** - Edit history is synced across all connected clients
- **Status feedback** - Users receive feedback when an edit is saved or fails

## Technical Implementation

### Backend Changes

#### Database Model (`models/Message.js`)
```javascript
const messageSchema = new mongoose.Schema({
  roomName:  { type: String, required: true, index: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:  { type: String, required: true },
  role:      { type: String, required: true },
  text:      { type: String, required: true },
  deleted:   { type: Boolean, default: false },
  editedAt:  { type: Date, default: null },
  editHistory: [{
    originalText: { type: String, required: true },
    editedText:   { type: String, required: true },
    editedAt:     { type: Date, default: Date.now },
    editedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  }],
}, { timestamps: true });
```

New fields added:
- `editedAt`: Timestamp of the last edit
- `editHistory`: Array tracking all edits with original/new text and editor info

#### Socket Handler (`server.js`)
New event: `message:edit`
```javascript
socket.on('message:edit', async ({ channelId, roomName, messageId, newText }) => {
  // Validates that only author or mods can edit
  // Prevents empty messages
  // Records edit in history
  // Broadcasts to all participants
});
```

#### Message History Updates
Both `room:join` and `channel:join` handlers now include:
- `editedAt`: When the message was last edited
- `editHistory`: Complete edit history array

### Frontend Changes

#### MessageList Component (`components/MessageList.jsx`)
New state variables:
- `editingMsgId`: Tracks which message is being edited
- `editText`: Stores the edited text while in edit mode
- `showEditHistory`: Shows the edit history modal

New functionality:
- `handleEditStart()`: Enters edit mode for a message
- `handleEditSave()`: Sends the edited message to the server
- `handleEditCancel()`: Cancels editing
- Edit button (✏️) in the toolbar
- Edit input UI with Save/Cancel buttons
- Edit history modal with timeline view

#### App.jsx
New socket event handler:
```javascript
socket.on('message:edited', ({ id, text, editedAt, hasEditHistory }) =>
  setMessages(prev =>
    prev.map(m => m.id === id ? { ...m, text, editedAt, hasEditHistory } : m)
  )
);
```

### Styling (`index.css`)
New CSS classes for:
- `.msg-edited-tag` - Visual indicator for edited messages
- `.msg-edit-input` - Textarea for editing
- `.msg-edit-buttons` - Save/Cancel buttons
- `.msg-edit-history-*` - Edit history modal and timeline

## User Interface

### Edit Button
- Appears in the message toolbar on hover
- Shows ✏️ emoji
- Only visible to message author or moderators
- Appears next to pin (📌) and delete (🗑️) buttons

### Edit Mode
- Textarea opens with current message text
- Auto-focused for immediate typing
- Save/Cancel buttons below the textarea
- Inline editing without leaving the chat

### Edit History
- Click on "(edited)" tag to view full history
- Modal shows:
  - Edit number and timestamp
  - Original text ("Before:")
  - Modified text ("After:")
  - Editor information if edited by moderator
- All edits displayed in chronological order

## Permissions & Security

### Who Can Edit?
- **Message Author**: Can always edit their own messages
- **Moderators/Owners**: Can edit any message in the server
- **Regular Members**: Cannot edit others' messages

### Validations
- ✓ Non-empty messages required
- ✓ Cannot edit to same text
- ✓ Deleted messages cannot be edited
- ✓ Permission checks enforced server-side
- ✓ Edit history immutable (read-only audit trail)

## Socket Events

### Emitted (Client → Server)
- `message:edit`: Request to edit a message
  ```javascript
  {
    channelId: string,
    roomName: string,
    messageId: string,
    newText: string
  }
  ```

### Received (Server → Client)
- `message:edited`: Broadcast when message is edited
  ```javascript
  {
    id: string,
    text: string,
    editedAt: Date,
    hasEditHistory: boolean
  }
  ```
- `error:message`: Error during edit (empty text, etc.)

## API Response

### Message Object (after joining room/channel)
```javascript
{
  id: string,
  userId: string,
  username: string,
  role: string,
  text: string,
  timestamp: Date,
  deleted: boolean,
  pinned: boolean,
  editedAt: Date | null,
  editHistory: Array<{
    originalText: string,
    editedText: string,
    editedAt: Date,
    editedBy: string | null
  }>
}
```

## User Experience Flow

1. **User sends message** → Message appears in chat
2. **User wants to change message** → Hover over message → Click ✏️
3. **Edit mode activates** → Textarea opens with original text
4. **User modifies text** → Can edit freely
5. **User saves** → Click "Save" button
6. **Broadcast to all** → All users see updated message + "(edited)" tag
7. **View history** → Click "(edited)" tag to see all changes

## Testing Checklist

- [ ] Can author edit their own message
- [ ] Can moderator edit any message
- [ ] Regular members cannot edit others' messages
- [ ] Cannot edit to empty text
- [ ] Cannot edit deleted message
- [ ] Edit history shows all previous versions
- [ ] "(edited)" tag appears after edit
- [ ] Real-time update for all participants
- [ ] Edit history modal displays correctly
- [ ] Timestamps are accurate
- [ ] Server validates permissions
- [ ] Database stores edits correctly

## Future Enhancements

Potential improvements for future versions:
- Edit notifications (e.g., "@user edited their message 2 minutes ago")
- Undo/Redo functionality
- Edit countdown timer (e.g., "Can only edit for 5 minutes")
- Diff highlighting between original and edited versions
- Edit reasons/notes
- Reaction to edits
- Edit statistics (most edited messages)

## Migration Notes

For existing databases, MongoDB will automatically add the new fields to the schema on first use. Existing messages without `editedAt` and `editHistory` will have:
- `editedAt: null`
- `editHistory: []`

These fields are optional in the model, ensuring backward compatibility.

## Rollback

If needed to rollback this feature:

1. Remove edit button from toolbar
2. Stop emitting `message:edit` events
3. Keep `message:edited` handler but don't use it
4. Keep database fields (non-destructive)
5. Edit history will remain in database for auditing

## Performance Considerations

- Edit history array grows with each edit (typically small)
- Most messages will have no edits (editHistory = [])
- Edit history stored inline with message document
- Index on `roomName` helps message lookups
- Lean queries used for history loading (no hydration)

## Security Considerations

- Edit permissions validated server-side
- Edit history immutable (append-only, no deletions)
- Cannot delete edit history
- Original message text always preserved
- Editor ID tracked for auditing
- Per-user permissions enforced
