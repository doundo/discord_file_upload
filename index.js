/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// Discord 웹훅의 최대 파일 크기 (8MB = 8 * 1024 * 1024 바이트)
const DISCORD_MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

export default {
	/**
	 * @param {Request} request
	 * @param {Env} env
	 * @param {ExecutionContext} ctx
	 */
	async fetch(request, env, ctx) {

		const { pathname } = new URL(request.url);
		
		// 파일 합치기 요청 처리 (GET /merge/<file_id>)
		if (request.method === 'GET' && pathname.startsWith('/merge/')) {
			const fileId = pathname.substring(pathname.lastIndexOf('/') + 1);

			if (!fileId) {
				return new Response('File ID is missing.', { status: 400 });
			}
			
			const db = env['discord-upload-db'];
			
			try {
				// 1. 원본 파일 메타데이터 조회
				const fileInfoStmt = db.prepare('SELECT * FROM uploaded_files WHERE file_id = ?');
				const fileInfo = await fileInfoStmt.bind(fileId).first();

				if (!fileInfo) {
					return new Response('File not found.', { status: 404 });
				}

				// 2. 모든 청크 정보 조회 (part_index 순으로 정렬)
				const partsInfoStmt = db.prepare('SELECT discord_url FROM file_parts WHERE file_id = ? ORDER BY part_index ASC');
				const partsInfo = await partsInfoStmt.bind(fileId).all();

				if (!partsInfo.results || partsInfo.results.length === 0) {
					return new Response('File parts not found for this file.', { status: 404 });
				}

				// 청크 URL들만 배열로 추출
				const discordUrls = partsInfo.results.map(part => part.discord_url);

				// 클라이언트로 합치기 요청에 필요한 정보 반환
				return new Response(JSON.stringify({
					filename: fileInfo.original_filename,
					urls: discordUrls
				}), {
					headers: { 'Content-Type': 'application/json' },
				});

			} catch (error) {
				console.error('Error fetching file parts from DB:', error);
				return new Response('Failed to retrieve file information from the database.', { status: 500 });
			}
		}

		// 실제 파일 합치기 엔드포인트 (POST /merge)
		if (request.method === 'POST' && pathname === '/merge') {
			const { fileId } = await request.json(); // 클라이언트로부터 fileId를 받음

			if (!fileId) {
				return new Response('File ID is required.', { status: 400 });
			}

			const db = env['discord-upload-db'];
			
			try {
				// 1. 모든 청크 URL을 가져옴
				const partsInfoStmt = db.prepare('SELECT discord_url FROM file_parts WHERE file_id = ? ORDER BY part_index ASC');
				const partsInfo = await partsInfoStmt.bind(fileId).all();

				if (!partsInfo.results || partsInfo.results.length === 0) {
					return new Response('File parts not found.', { status: 404 });
				}
				
				const discordUrls = partsInfo.results.map(part => part.discord_url);
				
				// 2. 각 청크를 병렬로 다운로드
				const fetchPromises = discordUrls.map(url => fetch(url));
				const responses = await Promise.all(fetchPromises);

				// 3. 각 응답에서 ArrayBuffer를 추출
				const bufferPromises = responses.map(response => {
					if (!response.ok) {
						throw new Error(`Failed to fetch a file part. Status: ${response.status}`);
					}
					return response.arrayBuffer();
				});
				const buffers = await Promise.all(bufferPromises);

				// 4. 모든 버퍼를 하나의 ArrayBuffer로 합침
				const totalLength = buffers.reduce((acc, buffer) => acc + buffer.byteLength, 0);
				const mergedBuffer = new Uint8Array(totalLength);
				let offset = 0;
				for (const buffer of buffers) {
					mergedBuffer.set(new Uint8Array(buffer), offset);
					offset += buffer.byteLength;
				}

				// 5. 원본 파일 메타데이터를 다시 조회
				const fileInfoStmt = db.prepare('SELECT original_filename, original_filetype FROM uploaded_files WHERE file_id = ?');
				const fileInfo = await fileInfoStmt.bind(fileId).first();

				// 6. 합쳐진 파일을 응답으로 보냄
				return new Response(mergedBuffer, {
					headers: {
						'Content-Type': fileInfo.original_filetype || 'application/octet-stream',
						'Content-Disposition': `attachment; filename="${fileInfo.original_filename}"`,
						'Content-Length': totalLength,
					},
				});

			} catch (error) {
				console.error('Error during file merge process:', error);
				return new Response(`Failed to merge file: ${error.message}`, { status: 500 });
			}
		}

		//POST 요청 처리(업로드)
		if (request.method === 'POST' && pathname === '/') {
			const contentType = request.headers.get('content-type');
			if (!contentType || !contentType.includes('multipart/form-data')) {
				return new Response('Expected multipart/form-data', { status: 400 });
			}

			const formData = await request.formData();
			const file = formData.get('file');

			if (!file || !(file instanceof File)) {
				return new Response('File field is missing or invalid file selected.', { status: 400 });
			}

			console.log(`Uploaded file name: ${file.name}, type: ${file.type}, size: ${file.size} bytes`);

			if (file.size > DISCORD_MAX_FILE_SIZE * 50) { // 예시: 50 * 8MB = 400MB 이상 파일은 너무 크다고 판단
				return new Response(`Total file is too large. Maximum allowed size for combined parts is ${DISCORD_MAX_FILE_SIZE * 50 / (1024 * 1024)} MB.`, { status: 413 });
			}


			const webhook = env.DISCORD_WEBHOOK;
            const db = env['discord-upload-db']; // D1 바인딩 이름 (wrangler.jsonc에서 설정)

            const fileId = crypto.randomUUID(); // 원본 파일을 위한 고유 ID 생성
            const uploadTimestamp = new Date().toISOString(); // 업로드 시간 기록

            const discordAttachmentUrls = []; // Discord에 업로드된 모든 청크의 URL을 저장할 배열
            const uploadPromises = []; // 모든 Discord 업로드 Promise를 저장할 배열
            let totalParts = 0; // 총 청크 개수

			if (file.size <= DISCORD_MAX_FILE_SIZE) {
				// 8MB 이하 파일은 바로 업로드
				const discordFormData = new FormData();
				discordFormData.append('file', file, file.name);
				uploadPromises.push(this.uploadFileToDiscord(webhook, discordFormData, file.name));
			} else {
				// 8MB 초과 파일은 분할하여 업로드
				let offset = 0;
				let partIndex = 0;

				while (offset < file.size) {
					const end = Math.min(offset + DISCORD_MAX_FILE_SIZE, file.size);
					const chunk = file.slice(offset, end);
					const chunkFileName = `${file.name}.part${String(partIndex).padStart(3, '0')}`;
					
					const discordFormData = new FormData();
					discordFormData.append('file', chunk, chunkFileName);
					
					// 각 청크 업로드 Promise를 배열에 추가
					uploadPromises.push(this.uploadFileToDiscord(webhook, discordFormData, chunkFileName));

					offset = end;
					partIndex++;
				}
                totalParts = partIndex; // 총 청크 개수 업데이트
			}

			try {
                // Discord에 모든 파일 청크 업로드
				const results = await Promise.all(uploadPromises); // 각 청크의 Discord 응답을 받음

                // Discord 응답에서 URL 추출하여 저장
                for (let i = 0; i < results.length; i++) {
                    const discordResponse = results[i];
                    // Discord가 200 OK와 함께 메시지 객체를 반환할 경우
                    if (discordResponse.status === 200) {
                        const responseData = await discordResponse.json();
                        // attachments 배열에서 첫 번째 첨부 파일의 URL 추출
                        if (responseData.attachments && responseData.attachments.length > 0) {
                            discordAttachmentUrls.push({
                                url: responseData.attachments[0].url,
                                filename: responseData.attachments[0].filename,
                                size: responseData.attachments[0].size,
                                partIndex: i // 몇 번째 청크인지 기록
                            });
                        }
                    } else if (discordResponse.status === 204) {
                        // 204 No Content인 경우, 첨부 파일 URL을 얻을 수 없으므로 추후 처리 필요
                        // 이 경우, Discord 웹훅 API를 wait=true로 호출하거나 다른 방식으로 URL을 가져와야 함.
                        // 일단 여기서는 204면 URL 저장을 스킵.
                        console.warn(`Discord returned 204 for part ${i}. No attachment URL available directly.`);
                    }
                }

                // D1 데이터베이스에 파일 메타데이터 및 청크 정보 저장
                // 원본 파일 정보 저장
                const insertFileStmt = db.prepare(
                    `INSERT INTO uploaded_files (file_id, original_filename, original_filesize, original_filetype, upload_timestamp)
                     VALUES (?, ?, ?, ?, ?)`
                );
                await insertFileStmt.bind(fileId, file.name, file.size, file.type, uploadTimestamp).run();

                // 각 청크 정보 저장
                const insertPartStmt = db.prepare(
                    `INSERT INTO file_parts (part_id, file_id, part_index, part_filename, discord_url, part_size)
                     VALUES (?, ?, ?, ?, ?, ?)`
                );

                const partInsertPromises = discordAttachmentUrls.map(partInfo => {
                    return insertPartStmt.bind(
                        crypto.randomUUID(), // 각 청크의 고유 ID
                        fileId,
                        partInfo.partIndex,
                        partInfo.filename,
                        partInfo.url,
                        partInfo.size
                    );
                });
                
                // 트랜잭션으로 여러 청크 정보를 한 번에 저장 (더 효율적)
                await db.batch(partInsertPromises);

				return new Response(`File(s) uploaded successfully! File ID: ${fileId}`, { status: 200 });
			} catch (error) {
				console.error('Error during file upload or DB save process:', error);
				const errorMessage = error.message.includes('Status: ') ? error.message : `An error occurred: ${error.message}`;
				return new Response(`Failed to upload file(s) to Discord or save info to DB. ${errorMessage}`, { status: 500 });
			}
		}

		// GET 요청 시 HTML 업로드 폼 제공 (이전과 동일)
		if (request.method === 'GET') {
			return new Response(`
				<!DOCTYPE html>
				<html lang="en">
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1.0" />
					<title>File Uploader</title>
					<style>
						/* 기존 스타일 */
						body { font-family: sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background-color: #f0f2f5; }
						form { background: white; padding: 2em; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); display: flex; flex-direction: column; gap: 1em; margin-bottom: 20px; }
						input[type="file"], input[type="text"] { border: 1px solid #ccc; padding: 0.5em; border-radius: 4px; }
						button { background-color: #007bff; color: white; padding: 0.7em 1.5em; border: none; border-radius: 4px; cursor: pointer; font-size: 1em; }
						button:hover { background-color: #0056b3; }
						.message { margin-top: 1em; padding: 0.8em; border-radius: 4px; }
						.success { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
						.error { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
						h2 { margin-top: 0; }
					</style>
				</head>
				<body>
					<form method="POST" enctype="multipart/form-data" id="uploadForm">
						<h2>Upload File to Discord</h2>
						<input type="file" name="file" required />
						<button type="submit">Upload</button>
						<div id="uploadMessage" class="message" style="display: none;"></div>
					</form>

					<form id="mergeForm">
						<h2>Merge Split File</h2>
						<label for="fileId">Enter File ID to merge:</label>
						<input type="text" id="fileId" name="fileId" required />
						<button type="submit">Merge and Download</button>
						<div id="mergeMessage" class="message" style="display: none;"></div>
					</form>

					<script>
						// 기존 스크립트 함수 (uploadForm 관련)
						const uploadForm = document.getElementById('uploadForm');
						const uploadMessageDiv = document.getElementById('uploadMessage');

						uploadForm.addEventListener('submit', async (e) => {
							e.preventDefault();

							const fileInput = document.querySelector('input[type="file"]');
							const file = fileInput.files[0];

							if (!file) {
								showMessage('uploadMessage', 'Please select a file.', 'error');
								return;
							}

							showMessage('uploadMessage', 'Uploading file...', 'success');

							try {
								const formData = new FormData();
								formData.append('file', file);
								
								const response = await fetch('/', { // Worker의 기본 경로인 '/'로 POST 요청
									method: 'POST',
									body: formData,
								});

								const resultText = await response.text();

								if (response.ok) {
									showMessage('uploadMessage', resultText, 'success');
									// 서버에서 파일 ID를 응답으로 주면, 그것을 보여주는 로직이 필요합니다.
									// 현재 Worker의 POST 응답은 "File(s) uploaded..." 문자열이라 ID는 포함되지 않습니다.
									// Worker의 POST 응답을 수정하여 fileId를 반환하게 해야 합니다.
									const fileIdMatch = resultText.match(/File ID: ([\w-]+)/);
									if (fileIdMatch && fileIdMatch[1]) {
										document.getElementById('fileId').value = fileIdMatch[1];
									}
								} else {
									showMessage('uploadMessage', 'Upload failed: ' + resultText, 'error');
								}
							} catch (error) {
								console.error('Upload Error:', error);
								showMessage('uploadMessage', 'Network error or an unexpected issue occurred: ' + error.message, 'error');
							}
						});

						// showMessage 헬퍼 함수는 그대로 사용 가능
						function showMessage(divId, text, type) {
							const messageDiv = document.getElementById(divId);
							messageDiv.textContent = text;
							messageDiv.className = 'message ' + type;
							messageDiv.style.display = 'block';
						}

						// 새로 추가할 스크립트 (mergeForm 관련)
						const mergeForm = document.getElementById('mergeForm');
						
						mergeForm.addEventListener('submit', async (e) => {
							e.preventDefault();
							const fileId = document.getElementById('fileId').value;
							if (!fileId) {
								showMessage('mergeMessage', 'Please enter a File ID.', 'error');
								return;
							}

							showMessage('mergeMessage', 'Merging file...', 'success');

							try {
								const response = await fetch('/merge', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ fileId: fileId }),
								});

								if (response.ok) {
									const blob = await response.blob();
									const contentDisposition = response.headers.get('Content-Disposition');
									let filename = 'merged-file';
									if (contentDisposition && contentDisposition.indexOf('attachment') !== -1) {
										const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
										if (filenameMatch && filenameMatch[1]) {
											filename = filenameMatch[1];
										}
									}
									
									const url = window.URL.createObjectURL(blob);
									const a = document.createElement('a');
									a.style.display = 'none';
									a.href = url;
									a.download = filename;
									document.body.appendChild(a);
									a.click();
									window.URL.revokeObjectURL(url);
									
									showMessage('mergeMessage', 'File merged and downloaded successfully!', 'success');
								} else {
									const errorText = await response.text();
									showMessage('mergeMessage', 'Failed to merge file: ' + errorText, 'error');
								}
							} catch (error) {
								showMessage('mergeMessage', 'Network error or an unexpected issue occurred: ' + error.message, 'error');
							}
						});
					</script>
				</body>
				</html>
			`, { headers: { 'content-type': 'text/html' } });
		}
	},

    /**
     * Discord 웹훅으로 파일을 업로드하고, Discord 응답 객체를 반환하는 헬퍼 함수
     * @param {string} webhookUrl - Discord 웹훅 URL
     * @param {FormData} formData - 파일이 포함된 FormData 객체
     * @param {string} filename - 업로드되는 파일 (청크)의 이름
     * @returns {Promise<Response>} - Discord fetch 응답 객체를 resolve, 실패 시 reject
     */
    async uploadFileToDiscord(webhookUrl, formData, filename) {
        try {
            // Discord 웹훅 호출 시 wait=true 파라미터를 추가하여 메시지 객체를 반환받도록 합니다.
            // 이렇게 해야 업로드된 첨부 파일의 URL을 응답에서 직접 얻을 수 있습니다.
            const urlWithWait = `${webhookUrl}?wait=true`;
            const discordResponse = await fetch(urlWithWait, {
                method: 'POST',
                body: formData,
            });

            if (discordResponse.ok) { // wait=true 시 성공 응답은 200 OK
                console.log(`Successfully uploaded ${filename}. Status: ${discordResponse.status}`);
                return discordResponse; 
            } else {
                const errorText = await discordResponse.text();
                const errorMsg = `Discord upload failed for ${filename}. Status: ${discordResponse.status}, Response: ${errorText}`;
                console.error(errorMsg);
                throw new Error(errorMsg); 
            }
        } catch (error) {
            console.error(`Error during Discord fetch for ${filename} in helper:`, error);
            throw error; 
        }
    }
};