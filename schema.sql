-- src/schema.sql
CREATE TABLE IF NOT EXISTS uploaded_files (
    file_id TEXT PRIMARY KEY,           -- 원본 파일의 고유 ID (UUID)
    original_filename TEXT NOT NULL,    -- 원본 파일 이름
    original_filesize INTEGER NOT NULL, -- 원본 파일 총 크기
    original_filetype TEXT,             -- 원본 파일 타입 (MIME)
    upload_timestamp TEXT NOT NULL      -- UTC 시간 (ISO 8601 형식)
);

CREATE TABLE IF NOT EXISTS file_parts (
    part_id TEXT PRIMARY KEY,           -- 각 청크의 고유 ID (UUID)
    file_id TEXT NOT NULL,              -- uploaded_files 테이블의 file_id 참조
    part_index INTEGER NOT NULL,        -- 파일의 몇 번째 부분인지 (0부터 시작)
    part_filename TEXT NOT NULL,        -- Discord에 업로드된 청크 파일 이름 (예: my_file.part_000)
    discord_url TEXT NOT NULL,          -- Discord에 업로드된 청크의 CDN URL
    part_size INTEGER NOT NULL,         -- 청크의 실제 크기
    FOREIGN KEY (file_id) REFERENCES uploaded_files (file_id) ON DELETE CASCADE
);